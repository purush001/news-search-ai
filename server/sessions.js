import { randomBytes } from 'node:crypto';

export const COOKIE_NAME = 'nsai_sid';

/** API keys live only here, in process memory, keyed by a random session id. */
export function createSessionStore({ ttlMs, max, now }) {
  const sessions = new Map();

  function sweep() {
    const t = now();
    for (const [id, s] of sessions) if (t - s.lastSeen > ttlMs) sessions.delete(id);
    while (sessions.size > max) sessions.delete(sessions.keys().next().value);
  }

  return {
    get(id) {
      if (!id) return null;
      const s = sessions.get(id);
      if (!s) return null;
      if (now() - s.lastSeen > ttlMs) {
        sessions.delete(id);
        return null;
      }
      s.lastSeen = now();
      return s;
    },
    create() {
      sweep();
      const id = randomBytes(32).toString('hex');
      const s = { id, openaiKey: null, serpapiKey: null, research: null, lastSeen: now() };
      sessions.set(id, s);
      return s;
    },
    destroy(id) {
      const s = sessions.get(id);
      if (s) {
        s.openaiKey = s.serpapiKey = null;
        s.research = null;
      }
      sessions.delete(id);
    },
    size: () => sessions.size,
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(id, { clear = false, secure = false } = {}) {
  const base = `${COOKIE_NAME}=${clear ? '' : id}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${8 * 60 * 60}`;
}
