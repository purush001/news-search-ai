import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/** Serves the built app. Returns a (req, res) handler that never throws. */
export function createStaticHandler(root) {
  const base = path.resolve(root);

  async function resolveFile(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname); // can throw on malformed escapes such as "/%"
    } catch {
      return { status: 400 };
    }
    if (decoded.includes('\0')) return { status: 400 };
    const target = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
    if (target !== base && !target.startsWith(base + path.sep)) return { status: 403 };
    try {
      const s = await stat(target);
      if (s.isFile()) return { file: target, size: s.size };
      if (s.isDirectory()) {
        const index = path.join(target, 'index.html');
        const si = await stat(index);
        if (si.isFile()) return { file: index, size: si.size };
      }
    } catch {
      /* not found */
    }
    if (path.extname(decoded)) return { status: 404 };
    try {
      const index = path.join(base, 'index.html');
      const si = await stat(index); // single-page app fallback
      return { file: index, size: si.size };
    } catch {
      return { status: 404 };
    }
  }

  return async function handler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        return plain(res, 405, 'Method not allowed');
      }
      let pathname;
      try {
        pathname = new URL(req.url || '/', 'http://localhost').pathname;
      } catch {
        return plain(res, 400, 'Bad request');
      }
      const found = await resolveFile(pathname);
      if (!found.file) {
        return plain(res, found.status, found.status === 400 ? 'Bad request' : found.status === 403 ? 'Forbidden' : 'Not found');
      }
      const ext = path.extname(found.file).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': found.size,
        'x-content-type-options': 'nosniff',
        'cache-control': found.file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(found.file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) plain(res, 500, 'Internal error');
      else res.destroy();
    }
  };
}
