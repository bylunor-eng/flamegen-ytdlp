// Minimal yt-dlp HTTP API — deploy on Render.com (free) or any host.
// GET /api?url=<youtube_url>  — extracts media URLs (returns proxy URLs)
// GET /proxy?url=<googlevideo_url>  — proxies the download (bypasses IP binding)
const { execFile } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';

function parseYtDlp(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-J', '--no-playlist', '--no-warnings',
      '--extractor-args', 'youtube:player_client=android,web',
      '--user-agent', 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
      url
    ];
    execFile('yt-dlp', args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('parse error')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === '/ping') return res.end(JSON.stringify({ status: 'ok' }));

  // Proxy endpoint — server downloads from googlevideo and streams bytes back.
  // Same IP extracted the URL = same IP downloads = no 403 from YouTube.
  if (u.pathname === '/proxy') {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) { res.statusCode = 403; return res.end('Unauthorized'); }
    const targetUrl = u.searchParams.get('url');
    if (!targetUrl || !targetUrl.includes('googlevideo.com')) {
      res.statusCode = 400; return res.end('Invalid url');
    }
    try {
      const r = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Range': 'bytes=0-' }
      });
      if (!r.ok) { res.statusCode = r.status; return res.end('Fetch failed: ' + r.status); }
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    } catch (e) {
      res.statusCode = 500; return res.end(JSON.stringify({ error: e.message || 'proxy failed' }));
    }
  }

  if (u.pathname !== '/api') {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'Use /api?url=<youtube_url>' }));
  }

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  const videoUrl = u.searchParams.get('url');
  if (!videoUrl) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Missing url param' }));
  }

  try {
    const info = await parseYtDlp(videoUrl);
    const ownBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const proxy = (url) => `${ownBase}/proxy?url=${encodeURIComponent(url)}`;

    const direct = (info.formats || []).filter((f) => f.url && (f.protocol === 'https' || f.protocol === 'http'));

    const hdVideo = direct.filter((f) =>
      f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none') && /mp4/i.test(f.ext)
    ).sort((a, b) => (b.height || 0) - (a.height || 0));
    const hd = hdVideo[0];

    const audioOnly = direct.filter((f) =>
      (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none' && /m4a/i.test(f.ext)
    ).sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    const muxedFormats = direct.filter((f) =>
      f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && /mp4/i.test(f.ext)
    ).sort((a, b) => Math.abs((a.height || 0) - 360) - Math.abs((b.height || 0) - 360));
    const muxed = muxedFormats[0];

    res.end(JSON.stringify({
      title: info.title || '',
      thumbnail: info.thumbnail || '',
      duration: info.duration || 0,
      medias: [
        hd ? { url: proxy(hd.url), quality: `${hd.height || 720}p`, extension: 'mp4', requiresMerge: true, videoAvailable: true, audioAvailable: false } : null,
        audioOnly ? { url: proxy(audioOnly.url), quality: `${audioOnly.abr || 128}kbps`, extension: 'm4a', requiresMerge: false, videoAvailable: false, audioAvailable: true } : null,
        muxed ? { url: proxy(muxed.url), quality: `${muxed.height || 360}p`, extension: 'mp4', requiresMerge: false, videoAvailable: true, audioAvailable: true } : null,
      ].filter(Boolean),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message || 'yt-dlp failed' }));
  }
});

server.listen(PORT, () => console.log(`yt-dlp API running on :${PORT}`));
