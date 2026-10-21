import { readFileSync } from 'node:fs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=';
const video = readFileSync(new URL('./sample.mp4', import.meta.url));
const jobs = new Map();
let sequence = 0;
export function resetMedia() { jobs.clear(); sequence = 0; }
export async function handleMedia(req, res, requests) {
  const path = new URL(req.url, 'http://fixture').pathname;
  if (!/\/v1\/(images\/generations|videos(?:\/.*)?)$/.test(path) && !path.endsWith('/fixture.png')) return false;
  res.setHeader('Content-Type', 'application/json');
  const json = (body, status = 200) => { res.writeHead(status); res.end(JSON.stringify(body)); };
  if (path.endsWith('/fixture.png')) { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from(png, 'base64')); return true; }
  if (req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = path.endsWith('/videos') ? Object.fromEntries(await new Request('http://fixture', { method: 'POST', body: raw, headers: { 'Content-Type': req.headers['content-type'] } }).formData()) : JSON.parse(raw);
    requests.push({ url: path, method: req.method, body, at: Date.now(), hasAuth: Boolean(req.headers.authorization) });
    if (path.startsWith('/media-error')) { json({ detail: 'fixture: unsupported size' }, 422); return true; }
    if (path.endsWith('/images/generations')) {
      const timer = setTimeout(() => json({ data: [path.startsWith('/media-url') ? { url: 'http://127.0.0.1:4174/fixture.png' } : { b64_json: png }], inference_time_s: .1 }), path.startsWith('/media-slow') ? 10000 : 300);
      res.on('close', () => clearTimeout(timer));
    } else {
      const id = `fixture-${++sequence}`;
      jobs.set(id, { path, polls: 0, downloads: 0, auth: Boolean(req.headers.authorization) });
      json({ id, status: 'queued', ...(!path.startsWith('/media-no-progress') ? { progress: 0 } : {}) });
    }
    return true;
  }
  const match = path.match(/\/videos\/([^/]+)(\/content)?$/);
  const id = match?.[1];
  const job = jobs.get(id);
  requests.push({ url: path, method: req.method, at: Date.now(), hasAuth: Boolean(req.headers.authorization) });
  if (!job) { json({ detail: 'unknown video' }, 404); return true; }
  if (req.method === 'DELETE') { jobs.delete(id); json({ deleted: true }); return true; }
  if (match[2]) {
    job.downloads++;
    if (job.auth && !req.headers.authorization) { json({ detail: 'missing authorization' }, 401); return true; }
    if (path.startsWith('/media-retry') && job.downloads === 1) { json({ detail: 'fixture download failed' }, 503); return true; }
    res.setHeader('Content-Type', 'video/mp4'); res.end(video); return true;
  }
  job.polls++;
  const requiredPolls = path.startsWith('/media-progress-slow') ? 6 : 2;
  const status = path.startsWith('/media-failed') ? 'failed' : job.polls < requiredPolls || path.startsWith('/media-slow') ? 'in_progress' : 'completed';
  const progress = status === 'completed' ? 100 : Math.min(95, job.polls * (requiredPolls === 6 ? 15 : 50));
  json({ id, status, ...(!path.startsWith('/media-no-progress') ? { progress } : {}), ...(path.startsWith('/media-failed') ? { error: { message: 'fixture generation failed' } } : { inference_time_s: .75 }) });
  return true;
}
