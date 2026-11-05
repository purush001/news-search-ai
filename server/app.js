import { APPROVALS_REQUIRED, WINDOW_MODES, X, MAX_NOTES_CHARS, isValidHttpUrl } from '../shared/index.js';
import { loadConfig } from './config.js';
import { AppError, toAppError } from './errors.js';
import { createOpenAIClient } from './providers/openai.js';
import { createSerpClient } from './providers/serpapi.js';
import { ideasById, runResearch, widenResearch } from './research.js';
import { createSessionStore, parseCookies, sessionCookie, COOKIE_NAME } from './sessions.js';
import { draftIdeas } from './drafting/runner.js';
import { linkedinAdapter } from './drafting/linkedin.js';
import { xAdapter } from './drafting/x.js';

const KEY_RE = /^[\x21-\x7e]{8,300}$/;
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

/** Builds the one API handler used by Vite middleware and by the standalone server. */
export function createApi(overrides = {}) {
  const config = loadConfig(overrides);
  const sessions = createSessionStore({ ttlMs: config.sessionTtlMs, max: config.maxSessions, now: config.now });

  function send(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(payload);
  }

  function sendError(res, err) {
    const e = toAppError(err);
    const headers = {};
    if (e.retryAfter != null) headers['retry-after'] = String(e.retryAfter);
    send(res, e.status, { error: e.toJSON() }, headers);
    return e.status;
  }

  async function readJsonBody(req) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new AppError('unsupported_media', 'Requests must use Content-Type: application/json.');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) throw new AppError('payload_too_large', 'Request body is too large.');
    // Some hosts (Vercel) parse JSON bodies before the handler runs and consume the stream.
    const bad = () => new AppError('bad_request', 'The request body must be a JSON object.');
    let pre;
    try {
      pre = req.body;
    } catch {
      throw bad();
    }
    if (pre !== undefined && pre !== null) {
      let v = Buffer.isBuffer(pre) ? pre.toString('utf8') : pre;
      if (typeof v === 'string') {
        if (Buffer.byteLength(v) > config.maxBodyBytes) throw new AppError('payload_too_large', 'Request body is too large.');
        try {
          v = v.length ? JSON.parse(v) : {};
        } catch {
          throw bad();
        }
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
      if (Buffer.byteLength(JSON.stringify(v)) > config.maxBodyBytes) throw new AppError('payload_too_large', 'Request body is too large.');
      return v;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > config.maxBodyBytes) throw new AppError('payload_too_large', 'Request body is too large.');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* fall through */
    }
    throw new AppError('bad_request', 'The request body must be a JSON object.');
  }

  function checkOrigin(req) {
    const host = String(req.headers.host || '');
    // Locally the Host must be loopback (DNS-rebinding guard). A hosted deployment has a public host name,
    // so there the same-origin check on writes below is what protects it.
    if (!config.allowAnyHost && !LOCAL_HOST_RE.test(host)) throw new AppError('forbidden_origin', 'Unexpected Host header.');
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let ok = false;
      try {
        ok = new URL(origin).host === host;
      } catch {
        ok = false;
      }
      if (!ok) throw new AppError('forbidden_origin', 'Cross-origin requests are not allowed.', { hint: 'Use the app from the address the server prints.' });
    } else {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') {
        throw new AppError('forbidden_origin', 'Cross-site requests are not allowed.');
      }
    }
  }

  function currentSession(req) {
    return sessions.get(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  }

  function requireKeys(session, { serp = false } = {}) {
    if (!session?.openaiKey || (serp && !session.serpapiKey)) {
      throw new AppError('keys_missing', serp ? 'Save both API keys before searching.' : 'Save your OpenAI key before drafting.');
    }
    return {
      config,
      openai: createOpenAIClient(config, session.openaiKey),
      serp: session.serpapiKey ? createSerpClient(config, session.serpapiKey) : null,
    };
  }

  function sessionStatus(session) {
    return {
      hasOpenAI: Boolean(session?.openaiKey),
      hasSerpapi: Boolean(session?.serpapiKey),
      model: config.model,
    };
  }

  function bad(msg) {
    return new AppError('bad_request', msg);
  }

  // ---- routes -------------------------------------------------------------

  const routes = {
    'GET /api/health': async (req, res) => send(res, 200, { ok: true }),

    'GET /api/session': async (req, res) => send(res, 200, sessionStatus(currentSession(req))),

    'PUT /api/session/keys': async (req, res) => {
      const body = await readJsonBody(req);
      const supplied = {};
      for (const field of ['openaiKey', 'serpapiKey']) {
        if (body[field] === undefined || body[field] === '') continue;
        if (typeof body[field] !== 'string' || !KEY_RE.test(body[field].trim())) {
          throw bad(`${field === 'openaiKey' ? 'The OpenAI' : 'The SerpAPI'} key looks malformed.`);
        }
        supplied[field] = body[field].trim();
      }
      if (!supplied.openaiKey && !supplied.serpapiKey) throw bad('Enter at least one API key.');
      // Verify with calls that cost nothing, before anything is stored.
      const checks = [];
      if (supplied.openaiKey) checks.push(createOpenAIClient(config, supplied.openaiKey).verify());
      if (supplied.serpapiKey) checks.push(createSerpClient(config, supplied.serpapiKey).verify());
      const results = await Promise.allSettled(checks);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;

      let session = currentSession(req);
      const isNew = !session;
      session ??= sessions.create();
      if (supplied.openaiKey) session.openaiKey = supplied.openaiKey;
      if (supplied.serpapiKey) session.serpapiKey = supplied.serpapiKey;
      send(res, 200, sessionStatus(session), isNew ? { 'set-cookie': sessionCookie(session.id, { secure: config.secureCookies }) } : {});
    },

    'DELETE /api/session': async (req, res) => {
      const session = currentSession(req);
      if (session) sessions.destroy(session.id);
      send(res, 200, sessionStatus(null), { 'set-cookie': sessionCookie('', { clear: true, secure: config.secureCookies }) });
    },

    'POST /api/research': async (req, res) => {
      const body = await readJsonBody(req);
      if (!WINDOW_MODES.includes(body.mode)) throw bad('Choose a search window mode.');
      if (body.lastRunEnd != null && typeof body.lastRunEnd !== 'string') throw bad('lastRunEnd must be a string.');
      const session = currentSession(req);
      const ctx = requireKeys(session, { serp: true });
      send(res, 200, await runResearch(ctx, session, { mode: body.mode, lastRunEnd: body.lastRunEnd }));
    },

    'POST /api/research/widen': async (req, res) => {
      const body = await readJsonBody(req);
      if (typeof body.runId !== 'string') throw bad('runId is required.');
      const session = currentSession(req);
      const ctx = requireKeys(session, { serp: true });
      send(res, 200, await widenResearch(ctx, session, { runId: body.runId, hours: body.hours }));
    },

    'POST /api/draft/linkedin': async (req, res) => {
      const { session, ctx, items } = await prepareDraft(req, (raw) => {
        const ctaUrl = typeof raw.ctaUrl === 'string' ? raw.ctaUrl.trim() : '';
        if (ctaUrl && !isValidHttpUrl(ctaUrl)) throw bad('The CTA URL must be a full http(s) URL.');
        return { ctaUrl: ctaUrl || null };
      });
      send(res, 200, { runId: session.research.runId, results: await draftIdeas(ctx, linkedinAdapter, items) });
    },

    'POST /api/draft/x': async (req, res) => {
      const { session, ctx, items } = await prepareDraft(req, (raw) => {
        const n = raw.tweetCount;
        if (!Number.isInteger(n) || n < X.minTweets || n > X.maxTweets) {
          throw bad(`Tweet count must be a whole number from ${X.minTweets} to ${X.maxTweets}.`);
        }
        return { tweetCount: n };
      });
      send(res, 200, { runId: session.research.runId, results: await draftIdeas(ctx, xAdapter, items) });
    },
  };

  async function prepareDraft(req, extra) {
    const body = await readJsonBody(req);
    const session = currentSession(req);
    const ctx = requireKeys(session);
    if (!session.research || session.research.runId !== body.runId) {
      throw new AppError('stale_run', 'These results are no longer available on the server (a newer search replaced them, or the server restarted).');
    }
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > APPROVALS_REQUIRED) {
      throw bad(`Send between 1 and ${APPROVALS_REQUIRED} approved ideas.`);
    }
    const known = ideasById(session);
    const seen = new Set();
    const items = body.items.map((raw) => {
      if (!raw || typeof raw !== 'object') throw bad('Each item must be an object.');
      const idea = known.get(raw.ideaId);
      if (!idea) throw bad('Unknown idea id.');
      if (seen.has(idea.id)) throw bad('Duplicate idea id.');
      seen.add(idea.id);
      const notes = raw.notes == null ? '' : raw.notes;
      if (typeof notes !== 'string' || notes.length > MAX_NOTES_CHARS) throw bad(`Notes must be text of at most ${MAX_NOTES_CHARS} characters.`);
      return { idea, notes: notes.trim(), ...extra(raw) };
    });
    return { session, ctx, items };
  }

  // ---- entry point --------------------------------------------------------

  /** Returns false when the request is not an API request. */
  async function handle(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return false;
    }
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return false;

    const started = Date.now();
    let status = 500;
    try {
      checkOrigin(req);
      const route = routes[`${req.method} ${pathname}`];
      if (!route) {
        const pathKnown = Object.keys(routes).some((k) => k.split(' ')[1] === pathname);
        throw pathKnown
          ? new AppError('method_not_allowed', 'Method not allowed.')
          : new AppError('not_found', 'Unknown API endpoint.');
      }
      await route(req, res);
      status = res.statusCode;
    } catch (err) {
      if (!res.headersSent) status = sendError(res, err);
      else res.end();
    } finally {
      // Only method, path, status and duration are ever logged.
      config.logger(`${req.method} ${pathname} ${status} ${Date.now() - started}ms`);
    }
    return true;
  }

  return { handle, config, sessions };
}
