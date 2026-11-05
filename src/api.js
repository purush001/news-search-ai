// Thin client for the local API. Credentials never pass through here after they are saved:
// the browser holds only an HttpOnly session cookie it cannot read.

export class ApiError extends Error {
  constructor({ code = 'internal', message = 'Something went wrong.', hint, retryAfter, detail, provider } = {}, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint || null;
    this.retryAfter = retryAfter ?? null;
    this.detail = detail || null;
    this.provider = provider || null;
    this.status = status;
  }
}

export const KEY_ERROR_CODES = ['invalid_openai_key', 'invalid_serpapi_key', 'keys_missing'];
export const isKeyError = (e) => Boolean(e && KEY_ERROR_CODES.includes(e.code));

/** Plain-object form so errors can live in React state. */
export function errorInfo(e) {
  if (e instanceof ApiError) {
    const { code, message, hint, retryAfter, detail, provider, status } = e;
    return { code, message, hint, retryAfter, detail, provider, status };
  }
  return { code: 'internal', message: e?.message || 'Something went wrong.', hint: null, retryAfter: null, detail: null, provider: null, status: 0 };
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError({ code: 'network', message: 'Could not reach the app server.', hint: 'Is it still running?' });
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) throw new ApiError(json?.error || { message: `The server answered ${res.status}.` }, res.status);
  return json;
}

export const api = {
  session: () => call('GET', '/api/session'),
  saveKeys: (keys) => call('PUT', '/api/session/keys', keys),
  clearSession: () => call('DELETE', '/api/session'),
  research: (body) => call('POST', '/api/research', body),
  widen: (body) => call('POST', '/api/research/widen', body),
  draftLinkedIn: (body) => call('POST', '/api/draft/linkedin', body),
  draftX: (body) => call('POST', '/api/draft/x', body),
};
