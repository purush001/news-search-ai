import http from 'node:http';
import { listen, sendJson, keyProblem } from './util.js';

const H = 3_600_000;

// Fictional placeholder stories. Titles say [Mock] so nothing is mistaken for real news.
// age = hours before "now". `cross` stories are also returned for general queries.
const STORIES = {
  oracle: [
    { t: 'Oracle Database gains agent tooling for SQL workflows', host: 'blogs.oracle.com', age: 3, cross: true },
    { t: 'OCI adds guardrails for generative AI service deployments', host: 'oracle.com', age: 6 },
    { t: 'Integrating Oracle Database vector search with LLM pipelines', host: 'www.theregister.com', age: 9 },
    { t: 'AI-assisted runbooks for Oracle production operations', host: 'devops.com', age: 14 },
    { t: 'Oracle AI agent integration patterns for enterprise apps', host: 'siliconangle.com', age: 20 },
  ],
  peoplesoft: [
    { t: 'PeopleSoft HCM adds AI-assisted job requisition drafting', host: 'blogs.oracle.com', age: 5 },
    { t: 'PeopleTools Integration Broker patterns for AI services', host: 'psadmin.io', age: 70 },
    { t: 'Modernizing PeopleSoft FSCM reporting with AI copilots', host: 'cio.com', age: 100 },
    { t: 'ERP modernization: where PeopleSoft fits in an agentic stack', host: 'computerworld.com', age: 130 },
  ],
  general: [
    { t: 'Open-weight model release targets long-running coding agents', host: 'huggingface.co', age: 2 },
    { t: 'Agent frameworks converge on Model Context Protocol servers', host: 'modelcontextprotocol.io', age: 4 },
    { t: 'New research paper evaluates tool-use reliability in agents', host: 'arxiv.org', age: 7 },
    { t: 'AI coding assistants add repository-wide change review', host: 'github.blog', age: 8 },
    { t: 'Startups report cost savings from small specialized models', host: 'techcrunch.com', age: 11 },
    { t: 'Evaluation harness released for agent regression testing', host: 'github.com', age: 13 },
    { t: 'Prompt caching changes the economics of agent loops', host: 'thenewstack.io', age: 16 },
    { t: 'Applied AI in production: lessons from on-call automation', host: 'infoq.com', age: 19 },
    { t: 'Guardrail libraries mature as agents move into production', host: 'venturebeat.com', age: 22 },
  ],
};

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function categoryOf(q) {
  if (/peopletools|peoplesoft/i.test(q)) return 'peoplesoft';
  if (/oracle/i.test(q)) return 'oracle';
  return 'general';
}

function dateField(ageH, now, i) {
  if (ageH < 24) {
    // alternate between relative, SerpAPI absolute and ISO forms
    if (i % 3 === 0) return { date: ageH <= 1 ? '1 hour ago' : `${Math.round(ageH)} hours ago` };
    const d = new Date(now - ageH * H);
    const p = (n) => String(n).padStart(2, '0');
    const h12 = d.getUTCHours() % 12 || 12;
    const serp = `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}, ${p(h12)}:${p(d.getUTCMinutes())} ${d.getUTCHours() >= 12 ? 'PM' : 'AM'}, +0000 UTC`;
    return i % 3 === 1 ? { date: serp } : { date: serp, iso_date: d.toISOString() };
  }
  const d = new Date(now - ageH * H);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return { date: `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` };
}

/**
 * Mock of the SerpAPI wire format used by this app:
 *   GET /account?api_key=...                      (free account check)
 *   GET /search.json?engine=google&tbm=nws&q=...&tbs=qdr:d|w|m&api_key=...
 * Like the real provider it applies the recency filter only coarsely, and it
 * sometimes returns stale or undated items so the app's local filter is exercised.
 */
export async function startMockSerpApi({ port = 0, stories = STORIES, now = () => Date.now(), onRequest, searchOverride } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = url.searchParams.get('api_key');
    calls.push({ path: url.pathname, q: url.searchParams.get('q'), tbs: url.searchParams.get('tbs'), key });
    onRequest?.(req, url);
    const problem = keyProblem(key);
    if (problem === 'bad' || problem === 'missing') {
      return sendJson(res, 401, { error: 'Invalid API key. Your API key should be at least 64 characters long.' });
    }
    if (problem === 'ratelimit') {
      return sendJson(res, 429, { error: 'Too many requests, slow down.' }, { 'retry-after': '7' });
    }
    if (problem === 'quota') {
      return sendJson(res, 429, { error: 'Your account has run out of searches.' });
    }
    if (url.pathname === '/account') {
      return sendJson(res, 200, { account_email: 'mock@example.test', plan_name: 'Mock', total_searches_left: 100 });
    }
    if (url.pathname !== '/search.json') return sendJson(res, 404, { error: 'Not found' });

    const q = url.searchParams.get('q') || '';
    const forced = searchOverride?.(q, url);
    if (forced) return sendJson(res, forced.status, forced.body, forced.headers);
    const tbs = url.searchParams.get('tbs') || '';
    const maxAge = tbs === 'qdr:d' ? 24 : tbs === 'qdr:w' ? 7 * 24 : tbs === 'qdr:m' ? 31 * 24 : 1e9;
    const cat = categoryOf(q);
    let pool = stories[cat].map((s) => ({ ...s, cat }));
    if (cat === 'general') pool = pool.concat(stories.oracle.filter((s) => s.cross).map((s) => ({ ...s, cat: 'oracle' })));
    const items = [];
    pool.forEach((s, i) => {
      if (s.age > maxAge) return;
      items.push({
        position: items.length + 1,
        title: `[Mock] ${s.t}`,
        link: `https://${s.host}/mock-demo/${slug(s.t)}`,
        source: s.host.replace(/^www\./, ''),
        snippet: `${s.t}. Placeholder snippet from the mock SerpAPI server.`,
        ...dateField(s.age, now(), i),
      });
    });
    // Coarse filter leaks: one stale and one undated item on 24h searches.
    if (tbs === 'qdr:d') {
      items.push({
        position: items.length + 1,
        title: `[Mock] Stale ${cat} item that the recency filter let through`,
        link: `https://example.com/mock-demo/stale-${cat}`,
        source: 'example.com',
        snippet: 'Older than the window.',
        date: '5 days ago',
      });
      items.push({
        position: items.length + 1,
        title: `[Mock] Undated ${cat} item`,
        link: `https://example.com/mock-demo/undated-${cat}`,
        source: 'example.com',
        snippet: 'No publication date.',
      });
    }
    sendJson(res, 200, { search_metadata: { status: 'Success' }, news_results: items });
  });
  const handle = await listen(server, port);
  return { ...handle, calls };
}
