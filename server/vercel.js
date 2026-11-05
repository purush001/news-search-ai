import { createApi } from './app.js';

/**
 * Adapter for Vercel's Node functions: (req, res) in, same API handler as everywhere else.
 * The api object is created once per function instance, so a warm instance keeps its in-memory sessions.
 * A new or different instance starts with none, so keys must be entered again (see README, "Vercel").
 */
export function createVercelHandler(api = createApi()) {
  return async function handler(req, res) {
    try {
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
