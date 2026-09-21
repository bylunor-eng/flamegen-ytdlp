// Minimal yt-dlp HTTP API — deploy on Render.com or any host.
// GET /api?url=<youtube_url>  — extracts media URLs (returns proxy URLs)
// GET /proxy?url=<googlevideo_url>  — proxies the download
//
// For YouTube's "Sign in to confirm you're not a bot" response, provide
// authorized YouTube cookies as the Render secret YOUTUBE_COOKIES_B64.
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const COOKIE_FILE = '/tmp/youtube-cookies.txt';

function prepareCookies() {
  const encoded = process.env.YOUTUBE_COOKIES_B64;
  if (!encoded) return null;

  try {
    const cookies = Buffer.from(encoded, 'base64').toString('utf8');
    if (!cookies.includes('# Netscape HTTP Cookie File') && !cookies.includes('\t')) {
      throw new Error('The decoded value does not look like a Netscape cookie file');
    }
    fs.writeFileSync(COOKIE_FILE, cookies, { mode: 0o600 });
    return COOKIE_FILE;
  } catch (error) {
    console.error(`Could not prepare YouTube cookies: ${error.message}`);
    return null;
  }
}

const cookieFile = prepareCookies();

function parseYtDlp(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-J', '--no-playlist', '--no-warnings',
      '--extractor-args', 'youtube:player_client=android,web',
      '--user-agent', 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
    ];

    if (cookieFile) args.push('--cookies', cookieFile);
    args.push(url);

    execFile('yt-dlp', args, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'yt-dlp failed').trim()));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error('yt-dlp returned invalid JSON'));
      }
    });
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === '/ping') {
    return sendJson(res, 200, { status: 'ok', cookiesConfigured: Boolean(cookieFile) });
  }

  if (u.pathname === '/proxy') {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return sendJson(res, 403, { error: 'Unauthorized' });
    }

    const targetUrl = u.searchParams.get('url');
    let target;
    try { target = new URL(targetUrl); } catch (error) { target = null; }

    if (!target || target.protocol !== 'https:' || !target.hostname.endsWith('googlevideo.com')) {
      return sendJson(res, 400, { error: 'Invalid media URL' });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
      });

      res.statusCode = upstream.status;
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }

      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'proxy failed' });
    }
  }

  if (u.pathname !== '/api') {
    return sendJson(res, 404, { error: 'Use /api?url=<youtube_url>' });
  }

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return sendJson(res, 403, { error: 'Unauthorized' });
  }

  const videoUrl = u.searchParams.get('url');
  if (!videoUrl) return sendJson(res, 400, { error: 'Missing url param' });

  try {
    const info = await parseYtDlp(videoUrl);
    const ownBase = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const proxy = (url) => `${ownBase}/proxy?url=${encodeURIComponent(url)}`;
    const direct = (info.formats || []).filter((f) => f.url && /^https?:$/.test(new URL(f.url).protocol));

    const hd = direct
      .filter((f) => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none') && /mp4/i.test(f.ext || ''))
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    const audioOnly = direct
      .filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none' && /m4a/i.test(f.ext || ''))
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    const muxed = direct
      .filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && /mp4/i.test(f.ext || ''))
      .sort((a, b) => Math.abs((a.height || 0) - 360) - Math.abs((b.height || 0) - 360))[0];

    return sendJson(res, 200, {
      title: info.title || '',
      thumbnail: info.thumbnail || '',
      duration: info.duration || 0,
      medias: [
        hd ? { url: proxy(hd.url), quality: `${hd.height || 720}p`, extension: 'mp4', requiresMerge: true, videoAvailable: true, audioAvailable: false } : null,
        audioOnly ? { url: proxy(audioOnly.url), quality: `${audioOnly.abr || 128}kbps`, extension: 'm4a', requiresMerge: false, videoAvailable: false, audioAvailable: true } : null,
        muxed ? { url: proxy(muxed.url), quality: `${muxed.height || 360}p`, extension: 'mp4', requiresMerge: false, videoAvailable: true, audioAvailable: true } : null,
      ].filter(Boolean),
    });
  } catch (error) {
    const message = error.message || 'yt-dlp failed';
    const status = /Sign in to confirm|cookies|not a bot/i.test(message) ? 503 : 500;
    return sendJson(res, status, {
      error: message,
      hint: status === 503 ? 'Configure the YOUTUBE_COOKIES_B64 Render secret with authorized YouTube cookies, then redeploy.' : undefined,
    });
  }
});

server.listen(PORT, () => console.log(`yt-dlp API running on :${PORT}; cookies: ${cookieFile ? 'configured' : 'not configured'}`));
