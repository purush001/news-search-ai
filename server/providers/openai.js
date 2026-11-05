import { AppError } from '../errors.js';
import { timedFetch, readJson, retryAfterSeconds } from './http.js';

const QUOTA_RE = /insufficient_quota|exceeded your current quota|billing|credit/i;

function mapOpenAIError(res, body, text, model) {
  const err = body?.error || {};
  const code = err.code || err.type || '';
  const message = typeof err.message === 'string' ? err.message : text.slice(0, 200);
  const detail = `${res.status} ${code} ${message}`;
  const opts = { provider: 'openai', detail };
  if (res.status === 401) {
    return new AppError('invalid_openai_key', 'OpenAI rejected the API key.', opts);
  }
  if (res.status === 403 || res.status === 404 || /model_not_found/.test(code)) {
    if (res.status === 403 && !/model/i.test(code + message)) {
      return new AppError('invalid_openai_key', 'OpenAI refused this key for the request.', opts);
    }
    return new AppError('model_access', `This key cannot use the model "${model}".`, opts);
  }
  if (res.status === 429) {
    if (QUOTA_RE.test(code + ' ' + message)) {
      return new AppError('quota_exhausted', 'The OpenAI account has no remaining quota.', opts);
    }
    const retryAfter = retryAfterSeconds(res);
    const wait = retryAfter != null ? ` Retry in about ${retryAfter}s.` : '';
    return new AppError('rate_limit', `OpenAI is rate limiting requests.${wait}`, { ...opts, retryAfter });
  }
  if (res.status >= 500) {
    return new AppError('upstream_unavailable', `OpenAI returned a temporary error (${res.status}).`, opts);
  }
  return new AppError('invalid_output', `OpenAI rejected the request (${res.status}).`, { ...opts, transient: false });
}

export function createOpenAIClient(config, apiKey) {
  const base = config.openaiBaseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const opts = { timeoutMs: config.openaiTimeoutMs, provider: 'openai' };

  return {
    /** Free check: GET /models/{model}. Proves the key is valid and can see the model. */
    async verify() {
      const res = await timedFetch(config.fetch, `${base}/models/${encodeURIComponent(config.model)}`, { method: 'GET', headers }, {
        timeoutMs: config.verifyTimeoutMs,
        provider: 'openai',
      });
      if (res.ok) return true;
      const { body, text } = await readJson(res);
      throw mapOpenAIError(res, body, text, config.model);
    },

    /** One JSON-mode chat completion. Returns the parsed JSON object. */
    async json({ system, user }) {
      const res = await timedFetch(
        config.fetch,
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        },
        opts,
      );
      const { body, text } = await readJson(res);
      if (!res.ok) throw mapOpenAIError(res, body, text, config.model);
      const choice = body?.choices?.[0];
      const content = choice?.message?.content;
      if (choice?.finish_reason === 'length') {
        throw new AppError('invalid_output', 'The model output was cut off.', { provider: 'openai' });
      }
      if (typeof content !== 'string' || !content.trim()) {
        throw new AppError('invalid_output', 'The model returned an empty answer.', { provider: 'openai' });
      }
      return parseModelJson(content);
    },
  };
}

export function parseModelJson(content) {
  let s = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1];
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  throw new AppError('invalid_output', 'The model returned malformed JSON.', { provider: 'openai' });
}
