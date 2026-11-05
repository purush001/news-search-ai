import { createApi } from './app.js';

/**
 * Adapter for Vercel's Node functions: (req, res) in, same API handler as everywhere else.
 * The api object is created once per function instance, so a warm instance keeps its in-memory sessions.
 * A new or different instance starts with none, so keys must be entered again (see README, "Vercel").
 */
/**
 * vercel.json rewrites /api/<sub/path> to /api?__path=<sub/path>. Restore the original URL so the handler routes
 * exactly as it does everywhere else. Only plain path characters are accepted, so a crafted value cannot escape /api.
 */
export function restoreApiUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl || '/', 'http://localhost');
  } catch {
    return rawUrl;
  }
  if (!u.searchParams.has('__path')) return rawUrl;
  const sub = u.searchParams.get('__path');
  u.searchParams.delete('__path');
  if (!/^[A-Za-z0-9_\-/]*$/.test(sub) || sub.split('/').some((seg) => seg === '..' || seg === '.')) return '/api/__invalid';
  return `/api${sub ? `/${sub.replace(/^\/+/, '')}` : ''}${u.search}`;
}

export function createVercelHandler(api = createApi()) {
  return async function handler(req, res) {
    try {
      req.url = restoreApiUrl(req.url);
      if (await api.handle(req, res)) return;
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'Unknown API endpoint.' } }));
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: { code: 'internal', message: 'Unexpected server error.' } }));
      } else {
        res.end();
      }
    }
  };
}
