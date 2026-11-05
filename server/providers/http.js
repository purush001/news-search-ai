import { AppError } from '../errors.js';
import { redact } from '../redact.js';

/** fetch with a timeout; maps transport failures to stable AppErrors. Never leaks URLs with keys. */
export async function timedFetch(fetchImpl, url, init, { timeoutMs, provider }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError' || ctrl.signal.aborted) {
      const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
      throw new AppError('timeout', `${providerName(provider)} did not answer within ${secs}s.`, { provider });
    }
    throw new AppError('network', `Could not reach ${providerName(provider)}.`, {
      provider,
      detail: redact(`${err?.cause?.code || ''} ${err?.message || ''}`),
    });
  } finally {
    clearTimeout(timer);
  }
}

export function providerName(p) {
  return p === 'openai' ? 'OpenAI' : p === 'serpapi' ? 'SerpAPI' : 'the provider';
}

export async function readJson(res) {
  const text = await res.text();
  if (!text) return { body: null, text };
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: null, text };
  }
}

export function retryAfterSeconds(res) {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - Date.now()) / 1000));
}
