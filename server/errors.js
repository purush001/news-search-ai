import { redact } from './redact.js';

/**
 * Stable error codes. The UI and tests key off `code`; messages may change.
 * `transient` errors are retried by the drafting runner without consuming a repair attempt.
 */
export const ERROR_CODES = {
  invalid_openai_key: { status: 401 },
  invalid_serpapi_key: { status: 401 },
  keys_missing: { status: 401 },
  model_access: { status: 403 },
  rate_limit: { status: 429 },
  quota_exhausted: { status: 402 },
  timeout: { status: 504, transient: true },
  network: { status: 502, transient: true },
  upstream_unavailable: { status: 502, transient: true },
  invalid_output: { status: 502, transient: true },
  request_rejected: { status: 502 },
  search_failed: { status: 502 },
  stale_run: { status: 409 },
  bad_request: { status: 400 },
  forbidden_origin: { status: 403 },
  unsupported_media: { status: 415 },
  payload_too_large: { status: 413 },
  not_found: { status: 404 },
  method_not_allowed: { status: 405 },
  internal: { status: 500 },
};

const HINTS = {
  invalid_openai_key: 'Check the OpenAI key and save it again with Edit API keys.',
  invalid_serpapi_key: 'Check the SerpAPI key and save it again with Edit API keys.',
  keys_missing: 'Enter and save both API keys first.',
  model_access: 'Your OpenAI project cannot use this model. Pick another model with OPENAI_MODEL or request access.',
  rate_limit: 'The provider is rate limiting requests. Wait a moment and retry.',
  quota_exhausted: 'The provider account has no remaining quota or credit. Add credit or switch keys.',
  timeout: 'The provider took too long to answer. Retry in a moment.',
  network: 'Could not reach the provider. Check your connection and retry.',
  upstream_unavailable: 'The provider reported a temporary failure. Retry in a moment.',
  invalid_output: 'The model returned unusable output. Retry the draft.',
  request_rejected: 'The provider refused the request itself, so retrying will not help. Check OPENAI_MODEL and that the model supports JSON output.',
  search_failed: 'The news search failed. Retry, or check your SerpAPI account.',
  stale_run: 'These results were replaced by a newer search. Run the search again.',
};

export class AppError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    const meta = ERROR_CODES[code] || ERROR_CODES.internal;
    this.status = opts.status ?? meta.status;
    this.provider = opts.provider || null;
    this.retryAfter = opts.retryAfter ?? null;
    this.hint = opts.hint ?? HINTS[code] ?? null;
    this.detail = opts.detail ? redact(String(opts.detail)).slice(0, 300) : null;
    this.transient = Boolean(opts.transient ?? meta.transient);
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.hint) out.hint = this.hint;
    if (this.provider) out.provider = this.provider;
    if (this.retryAfter != null) out.retryAfter = this.retryAfter;
    if (this.detail) out.detail = this.detail;
    return out;
  }
}

/** Coerce anything thrown into an AppError whose message is safe to show. */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  return new AppError('internal', 'Unexpected server error.', { detail: err?.message });
}
