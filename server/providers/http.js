import { AppError } from '../errors.js';
import { redact } from '../redact.js';

/**
 * fetch with one timeout that covers headers AND the body, so a provider that sends headers and then
 * stalls cannot hang a request. Returns { ok, status, headers, text, body } (body = parsed JSON or null).
 * Transport failures become stable AppErrors; URLs (which may carry keys) are never included.
 */
export async function timedFetch(fetchImpl, url, init, { timeoutMs, provider }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON */
      }
    }
    return { ok: res.ok, status: res.status, headers: res.headers, text, body };
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

export function retryAfterSeconds(res) {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - Date.now()) / 1000));
}
