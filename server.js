const { execFile } = require('child_process');
const http = require('http');
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
function parseYtDlp(url) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', ['-J', '--no-playlist', '--no-warnings', url], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
  if (u.pathname !== '/api') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'Use /api?url=<youtube_url>' })); }
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Unauthorized' })); }
  const videoUrl = u.searchParams.get('url');
  if (!videoUrl) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Missing url param' })); }
  try {
    const info = await parseYtDlp(videoUrl);
    const hdVideo = (info.formats || []).filter((f) => f.url && f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none') && /mp4/i.test(f.ext)).sort((a, b) => (b.height || 0) - (a.height || 0));
    const hd = hdVideo[0];
    const audioOnly = (info.formats || []).filter((f) => f.url && f.vcodec === 'none' && f.acodec !== 'none' && /m4a/i.test(f.ext)).sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    const muxedFormats = (info.formats || []).filter((f) => f.url && f.acodec && f.acodec !== 'none' && f.vcodec && f.vcodec !== 'none' && /mp4/i.test(f.ext)).sort((a, b) => Math.abs((a.height || 0) - 360) - Math.abs((b.height || 0) - 360));
    const muxed = muxedFormats[0];
    res.end(JSON.stringify({ title: info.title || '', thumbnail: info.thumbnail || '', duration: info.duration || 0, medias: [ hd ? { url: hd.url, quality: `${hd.height || 720}p`, extension: 'mp4', requiresMerge: true, videoAvailable: true, audioAvailable: false } : null, audioOnly ? { url: audioOnly.url, quality: `${audioOnly.abr || 128}kbps`, extension: 'm4a', requiresMerge: false, videoAvailable: false, audioAvailable: true } : null, muxed ? { url: muxed.url, quality: `${muxed.height || 360}p`, extension: 'mp4', requiresMerge: false, videoAvailable: true, audioAvailable: true } : null ].filter(Boolean) }));
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message || 'yt-dlp failed' })); }
});
server.listen(PORT, () => console.log(`yt-dlp API running on :${PORT}`));
