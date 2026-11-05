import { AppError } from '../errors.js';
import { timedFetch, readJson, retryAfterSeconds } from './http.js';

const QUOTA_RE = /run out of searches|out of searches|searches? (for the month )?(are|is) exhausted|plan.*(limit|exceeded)|account has no/i;
const NO_RESULTS_RE = /hasn'?t returned any results|no results/i;

function mapSerpError(res, body, text) {
  const message = typeof body?.error === 'string' ? body.error : text.slice(0, 200);
  const opts = { provider: 'serpapi', detail: `${res.status} ${message}` };
  if (res.status === 401 || res.status === 403 || /invalid api key|api key.*(missing|invalid)/i.test(message)) {
    return new AppError('invalid_serpapi_key', 'SerpAPI rejected the API key.', opts);
  }
  if (res.status === 429 || res.status === 402) {
    if (QUOTA_RE.test(message) || res.status === 402) {
      return new AppError('quota_exhausted', 'The SerpAPI account has no searches left.', opts);
    }
    const retryAfter = retryAfterSeconds(res);
    const wait = retryAfter != null ? ` Retry in about ${retryAfter}s.` : '';
    return new AppError('rate_limit', `SerpAPI is rate limiting requests.${wait}`, { ...opts, retryAfter });
  }
  return new AppError('search_failed', `SerpAPI search failed (${res.status}).`, opts);
}

/** Coarse provider recency filter; exact filtering happens locally. */
export function recencyFilter(hours) {
  if (hours <= 24) return 'qdr:d';
  if (hours <= 7 * 24) return 'qdr:w';
  return 'qdr:m';
}

export function createSerpClient(config, apiKey) {
  const base = config.serpapiBaseUrl.replace(/\/+$/, '');
  const opts = { timeoutMs: config.serpTimeoutMs, provider: 'serpapi' };

  return {
    /** Free check: GET /account. */
    async verify() {
      const url = `${base}/account?api_key=${encodeURIComponent(apiKey)}`;
      const res = await timedFetch(config.fetch, url, { method: 'GET' }, { timeoutMs: config.verifyTimeoutMs, provider: 'serpapi' });
      if (res.ok) return true;
      const { body, text } = await readJson(res);
      throw mapSerpError(res, body, text);
    },

    /** Google News search. Returns normalized raw items (dates still unparsed). */
    async news(query, hours) {
      const params = new URLSearchParams({
        engine: 'google',
        tbm: 'nws',
        q: query,
        tbs: recencyFilter(hours),
        num: '20',
        hl: 'en',
        gl: 'us',
        api_key: apiKey,
      });
      const res = await timedFetch(config.fetch, `${base}/search.json?${params}`, { method: 'GET' }, opts);
      const { body, text } = await readJson(res);
      if (!res.ok) {
        if (NO_RESULTS_RE.test(String(body?.error || ''))) return [];
        throw mapSerpError(res, body, text);
      }
      if (body && typeof body.error === 'string') {
        if (NO_RESULTS_RE.test(body.error)) return [];
        throw mapSerpError({ status: 400, headers: res.headers }, body, text);
      }
      if (!body || typeof body !== 'object') {
        throw new AppError('search_failed', 'SerpAPI returned an unreadable response.', { provider: 'serpapi' });
      }
      const items = Array.isArray(body.news_results) ? body.news_results : [];
      return items.map(normalizeItem).filter(Boolean);
    },
  };
}

function normalizeItem(it) {
  if (!it || typeof it.link !== 'string' || typeof it.title !== 'string') return null;
  const source = typeof it.source === 'string' ? it.source : it.source?.name || '';
  return {
    title: it.title.trim().slice(0, 300),
    url: it.link,
    source: String(source).slice(0, 120),
    dateRaw: typeof it.iso_date === 'string' ? it.iso_date : typeof it.date === 'string' ? it.date : null,
    dateAlt: typeof it.iso_date === 'string' && typeof it.date === 'string' ? it.date : null,
    snippet: typeof it.snippet === 'string' ? it.snippet.trim().slice(0, 400) : '',
  };
}
