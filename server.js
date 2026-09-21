const { execFile } = require('child_process');
const http = require('http');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

function parseYtDlp(url) {
  return new Promise((resolve, reject) => {
    execFile(
      'yt-dlp',
      ['-J', '--no-playlist', '--no-warnings', url],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(stderr?.trim() || err.message || 'yt-dlp failed'));
        }

        const text = (stdout || '').trim();
        if (!text) {
          return reject(new Error('yt-dlp returned empty output'));
        }

        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('Failed to parse yt-dlp output'));
        }
      }
    );
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === '/ping') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (u.pathname !== '/api') {
    return sendJson(res, 404, { error: 'Use /api?url=<youtube_url>' });
  }

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return sendJson(res, 403, { error: 'Unauthorized' });
  }

  const rawUrl = u.searchParams.get('url');
  if (!rawUrl) {
    return sendJson(res, 400, { error: 'Missing url param' });
  }

  try {
    const info = await parseYtDlp(rawUrl);

    const hdVideo = (info.formats || [])
      .filter((f) => f.url && f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none') && /mp4/i.test(f.ext || ''))
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const hd = hdVideo[0];

    const audioOnly = (info.formats || [])
      .filter((f) => f.url && f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && /m4a/i.test(f.ext || ''))
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    const muxedFormats = (info.formats || [])
      .filter((f) => f.url && f.acodec && f.acodec !== 'none' && f.vcodec && f.vcodec !== 'none' && /mp4/i.test(f.ext || ''))
      .sort((a, b) => Math.abs((a.height || 0) - 360) - Math.abs((b.height || 0) - 360));

    const muxed = muxedFormats[0];

    const medias = [
      hd
        ? { url: hd.url, quality: `${hd.height || 720}p`, extension: 'mp4', requiresMerge: true, videoAvailable: true, audioAvailable: false }
        : null,
      audioOnly
        ? { url: audioOnly.url, quality: `${audioOnly.abr || 128}kbps`, extension: 'm4a', requiresMerge: false, videoAvailable: false, audioAvailable: true }
        : null,
      muxed
        ? { url: muxed.url, quality: `${muxed.height || 360}p`, extension: 'mp4', requiresMerge: false, videoAvailable: true, audioAvailable: true }
        : null,
    ].filter(Boolean);

    if (!medias.length) {
      return sendJson(res, 404, { error: 'No downloadable media found for this URL' });
    }

    return sendJson(res, 200, {
      title: info.title || '',
      thumbnail: info.thumbnail || '',
      duration: info.duration || 0,
      medias,
    });
  } catch (e) {
    return sendJson(res, 500, { error: e.message || 'yt-dlp failed' });
  }
});

server.listen(PORT, () => {
  console.log(`yt-dlp API running on :${PORT}`);
});
