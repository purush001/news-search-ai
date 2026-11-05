import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack, rawRequest, research, OPENAI_KEY, SERP_KEY } from './helpers.js';
import { httpResponse } from '../server/mock/openai.js';
import { WRITING_STANDARD } from '../server/prompts.js';
import { weightedLength } from '../shared/index.js';

async function withStack(t, opts) {
  const stack = await startStack(opts);
  t.after(() => stack.close());
  return stack;
}

async function ready(t, opts) {
  const stack = await withStack(t, opts);
  const client = stack.client();
  await client.saveKeys();
  return { stack, client };
}

const draftItems = (ideas, extra = () => ({})) => ideas.map((idea, i) => ({ ideaId: idea.id, notes: '', ...extra(idea, i) }));

// ---------------------------------------------------------------------------
// credentials and transport hardening
// ---------------------------------------------------------------------------

test('invalid keys are rejected with stable codes and never echoed', async (t) => {
  const stack = await withStack(t);
  const client = stack.client();
  const badOpenAI = 'sk-bad-openai-key-0123456789abcdef';
  const r1 = await client.put('/api/session/keys', { openaiKey: badOpenAI, serpapiKey: SERP_KEY });
  assert.equal(r1.status, 401);
  assert.equal(r1.json.error.code, 'invalid_openai_key');
  assert.ok(!r1.text.includes(badOpenAI), 'key echoed by the provider must not reach the browser');
  assert.ok(!r1.headers['set-cookie'], 'no session is created for a rejected key');

  const badSerp = 'serp-bad-key-0123456789abcdef0123456789abcdef';
  const r2 = await client.put('/api/session/keys', { openaiKey: OPENAI_KEY, serpapiKey: badSerp });
  assert.equal(r2.status, 401);
  assert.equal(r2.json.error.code, 'invalid_serpapi_key');
  assert.ok(!r2.text.includes(badSerp));

  const status = await client.get('/api/session');
  assert.deepEqual(status.json, { hasOpenAI: false, hasSerpapi: false, model: 'gpt-6.1-sol' });
  assert.ok(!stack.logs.join('\n').includes(badOpenAI));
});

test('keys are verified with free calls only (GET /models/{model}, GET /account)', async (t) => {
  const { stack } = await ready(t);
  assert.deepEqual(stack.openai.calls.map((c) => c.task), ['verify']);
  assert.equal(stack.openai.calls[0].model, 'gpt-6.1-sol');
  assert.deepEqual(stack.serp.calls.map((c) => c.path), ['/account']);
});

test('session cookie is HttpOnly, SameSite=Strict, random, and the status never returns a key', async (t) => {
  const stack = await withStack(t);
  const client = stack.client();
  const r = await client.saveKeys();
  const cookie = r.headers['set-cookie'][0];
  assert.match(cookie, /^nsai_sid=[a-f0-9]{64};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.ok(!cookie.includes(OPENAI_KEY) && !cookie.includes(SERP_KEY));
  assert.ok(!r.text.includes(OPENAI_KEY) && !r.text.includes(SERP_KEY));
  assert.deepEqual(r.json, { hasOpenAI: true, hasSerpapi: true, model: 'gpt-6.1-sol' });
  const again = await client.get('/api/session');
  assert.deepEqual(again.json, { hasOpenAI: true, hasSerpapi: true, model: 'gpt-6.1-sol' });
  const other = stack.client();
  assert.equal((await other.get('/api/session')).json.hasOpenAI, false, 'a different browser has no keys');
});

test('a single key can be replaced without re-entering the other', async (t) => {
  const { stack, client } = await ready(t);
  const r = await client.put('/api/session/keys', { openaiKey: 'sk-test-openai-replaced-0123456789' });
  assert.equal(r.status, 200);
  assert.equal(r.json.hasSerpapi, true);
  const rejected = await client.put('/api/session/keys', { serpapiKey: 'serp-bad-0123456789abcdef' });
  assert.equal(rejected.status, 401);
  assert.equal((await client.get('/api/session')).json.hasSerpapi, true, 'a rejected key leaves the stored one untouched');
  assert.ok(stack.serp.calls.length >= 2);
});

test('malformed keys and bodies are rejected before any provider is called', async (t) => {
  const stack = await withStack(t);
  const client = stack.client();
  for (const body of [{}, { openaiKey: 'short' }, { openaiKey: 'has space in it 123456' }, { openaiKey: 12345678 }, { serpapiKey: 'bad\nkey\r\nx-injected: 1' }]) {
    const r = await client.put('/api/session/keys', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, 'bad_request');
  }
  assert.equal(stack.openai.calls.length, 0);
  assert.equal(stack.serp.calls.length, 0);
  const notObject = await client.put('/api/session/keys', '[1,2]');
  assert.equal(notObject.status, 400);
  const invalidJson = await client.put('/api/session/keys', '{oops');
  assert.equal(invalidJson.status, 400);
});

test('cross-origin writes, foreign Host headers, wrong content types and oversize bodies are refused', async (t) => {
  const stack = await withStack(t);
  const body = JSON.stringify({ openaiKey: OPENAI_KEY, serpapiKey: SERP_KEY });
  const base = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };

  const cross = await rawRequest(stack.base, { method: 'PUT', path: '/api/session/keys', headers: { ...base, origin: 'http://evil.example' }, body });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, 'forbidden_origin');

  const crossSite = await rawRequest(stack.base, { method: 'PUT', path: '/api/session/keys', headers: { ...base, 'sec-fetch-site': 'cross-site' }, body });
  assert.equal(crossSite.status, 403);

  const rebind = await rawRequest(stack.base, { method: 'GET', path: '/api/session', headers: { host: 'attacker.example' } });
  assert.equal(rebind.status, 403);

  const sameOrigin = await rawRequest(stack.base, { method: 'PUT', path: '/api/session/keys', headers: { ...base, origin: stack.base }, body });
  assert.equal(sameOrigin.status, 200);

  const text = await rawRequest(stack.base, { method: 'PUT', path: '/api/session/keys', headers: { 'content-type': 'text/plain', 'content-length': body.length }, body });
  assert.equal(text.status, 415);

  const huge = JSON.stringify({ openaiKey: 'x'.repeat(200_000) });
  const big = await rawRequest(stack.base, { method: 'PUT', path: '/api/session/keys', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(huge) }, body: huge });
  assert.equal(big.status, 413);

  assert.equal((await rawRequest(stack.base, { path: '/api/nope' })).status, 404);
  assert.equal((await rawRequest(stack.base, { method: 'PATCH', path: '/api/session' })).status, 405);
});

test('session clearing removes keys and research, and expires the cookie', async (t) => {
  const { client } = await ready(t);
  const r = await client.del('/api/session');
  assert.equal(r.status, 200);
  assert.match(r.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal(r.json.hasOpenAI, false);
  const after = await client.post('/api/research', { mode: '24h' });
  assert.equal(after.status, 401);
  assert.equal(after.json.error.code, 'keys_missing');
});

test('model access, rate limit and quota errors at key verification map to stable codes', async (t) => {
  const denied = await withStack(t, { openai: { modelsDenied: ['gpt-6.1-sol'] } });
  const c1 = denied.client();
  const r1 = await c1.put('/api/session/keys', { openaiKey: OPENAI_KEY });
  assert.equal(r1.status, 403);
  assert.equal(r1.json.error.code, 'model_access');
  assert.match(r1.json.error.message, /gpt-6\.1-sol/);

  const stack = await withStack(t);
  const c2 = stack.client();
  const rl = await c2.put('/api/session/keys', { openaiKey: 'sk-test-ratelimit-0123456789abcdef' });
  assert.equal(rl.status, 429);
  assert.equal(rl.json.error.code, 'rate_limit');
  assert.equal(rl.json.error.retryAfter, 11);
  assert.equal(rl.headers['retry-after'], '11');
  assert.match(rl.json.error.message, /11s/);

  const q = await c2.put('/api/session/keys', { openaiKey: 'sk-test-quota-0123456789abcdef' });
  assert.equal(q.status, 402);
  assert.equal(q.json.error.code, 'quota_exhausted');

  const sq = await c2.put('/api/session/keys', { serpapiKey: 'serp-quota-0123456789abcdef' });
  assert.equal(sq.status, 402);
  assert.equal(sq.json.error.code, 'quota_exhausted');
  assert.equal(sq.json.error.provider, 'serpapi');
});

test('provider timeout and network failures map to stable codes', async (t) => {
  const slow = await ready(t, {
    config: { openaiTimeoutMs: 150 },
    openai: { respond: (task) => (task === 'research_ideas' ? new Promise((r) => setTimeout(() => r({ ideas: [] }), 800)) : undefined) },
  });
  const r = await slow.client.post('/api/research', { mode: '24h' });
  assert.equal(r.status, 504);
  assert.equal(r.json.error.code, 'timeout');
  assert.equal(r.json.error.provider, 'openai');
  assert.match(r.json.error.message, /within 1s/);
  assert.equal(slow.stack.openai.calls.filter((c) => c.task === 'research_ideas').length, 3, 'timeouts are transient: tried three times');

  const s2 = await withStack(t, { config: { openaiBaseUrl: 'http://127.0.0.1:1/v1' } });
  const down = await s2.client().put('/api/session/keys', { openaiKey: OPENAI_KEY });
  assert.equal(down.status, 502);
  assert.equal(down.json.error.code, 'network');
  assert.ok(!down.text.includes(OPENAI_KEY));
});

// ---------------------------------------------------------------------------
// research
// ---------------------------------------------------------------------------

test('research returns 10 ideas with local date filtering; a PeopleSoft shortfall is reported exactly', async (t) => {
  const { stack, client } = await ready(t);
  const r = await research(client);

  assert.equal(r.ideas.length, 9);
  const byCat = (c) => r.ideas.filter((i) => i.category === c).length;
  assert.deepEqual([byCat('oracle'), byCat('peoplesoft'), byCat('general')], [2, 1, 6]);
  assert.equal(r.quotas.peoplesoft.missing, 1);
  assert.equal(r.missingTotal, 1);
  assert.equal(r.complete, false);
  assert.equal(r.marker.advance, false);
  assert.equal(r.marker.value, null);
  assert.match(r.marker.reason, /1 idea is still missing/);

  // every source is dated, inside the window, and none is a stale/undated leak
  const start = Date.parse(r.window.start);
  const end = Date.parse(r.window.end);
  assert.ok(end - start === 24 * 3_600_000);
  for (const idea of r.ideas) {
    assert.ok(idea.sources.length >= 1);
    for (const s of idea.sources) {
      assert.ok(Date.parse(s.publishedAt) > start && Date.parse(s.publishedAt) <= end, s.publishedAt);
      assert.ok(!/stale|undated/.test(s.url));
    }
  }
  // 15 queries, coarse recency filter on every one
  const searches = stack.serp.calls.filter((c) => c.path === '/search.json');
  assert.equal(searches.length, 15);
  assert.ok(searches.every((c) => c.tbs === 'qdr:d'));
  // the keys used upstream are the session's keys
  assert.ok(searches.every((c) => c.key === SERP_KEY));
  assert.ok(stack.openai.calls.filter((c) => c.task === 'research_ideas').every((c) => c.key === OPENAI_KEY));
});

test('the model references candidates by id only: prompts carry no URLs and fabricated ids are dropped', async (t) => {
  const { stack, client } = await ready(t, {
    openai: {
      respond: (task, input, ctx) => {
        if (task !== 'research_ideas') return undefined;
        const out = ctx.default();
        out.ideas.push({ category: 'general', headline: 'Fabricated', summary: 's', angle: 'a', confirmed: 'c', application: 'x', sourceIds: ['c999'] });
        out.ideas[0].summary += ' Read more at https://fabricated.example/story';
        return out;
      },
    },
  });
  const r = await research(client);
  const call = stack.openai.calls.find((c) => c.task === 'research_ideas');
  assert.ok(!/https?:\/\//.test(call.user.replace('https://platform', '')), 'no URL is sent to the model');
  assert.ok(!r.ideas.some((i) => i.headline === 'Fabricated'));
  assert.ok(!JSON.stringify(r).includes('fabricated.example'));
  assert.equal(call.responseFormat.type, 'json_object');
});

test('widening fills only the missing category, keeps ideas and the original window end, then advances the marker', async (t) => {
  const { stack, client } = await ready(t);
  const first = await research(client);
  const before = first.ideas.map((i) => i.id);
  const searchesBefore = stack.serp.calls.filter((c) => c.path === '/search.json').length;

  const tooNarrow = await client.post('/api/research/widen', { runId: first.runId, hours: 24 });
  assert.equal(tooNarrow.status, 400);
  const stale = await client.post('/api/research/widen', { runId: 'nope', hours: 168 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'stale_run');
  const tooWide = await client.post('/api/research/widen', { runId: first.runId, hours: 24 * 31 });
  assert.equal(tooWide.status, 400);

  const w = await client.post('/api/research/widen', { runId: first.runId, hours: 168 });
  assert.equal(w.status, 200);
  const r = w.json;
  assert.equal(r.ideas.length, 10);
  assert.deepEqual(r.ideas.slice(0, 9).map((i) => i.id), before, 'existing ideas are kept');
  assert.equal(r.ideas[9].category, 'peoplesoft');
  assert.equal(r.window.end, first.window.end, 'original window end is kept');
  assert.equal(r.window.start, first.window.start);
  assert.deepEqual(r.widened.map((x) => x.categories), [['peoplesoft']]);
  assert.equal(r.widened[0].hours, 168);
  assert.equal(r.quotas.peoplesoft.missing, 0);
  assert.equal(r.complete, true);
  assert.deepEqual(r.marker, { advance: true, value: first.window.end, reason: null });

  const widened = stack.serp.calls.filter((c) => c.path === '/search.json').slice(searchesBefore);
  assert.equal(widened.length, 4, 'only the four PeopleSoft queries are re-run');
  assert.ok(widened.every((c) => /peoplesoft|peopletools/i.test(c.q)));
  assert.ok(widened.every((c) => c.tbs === 'qdr:w' || c.tbs === 'qdr:m'), 'coarse recency filter at least as wide as the window');
  // the newly found source is older than the original 24h window but inside the widened one
  const added = r.ideas[9].sources[0];
  assert.ok(Date.parse(added.publishedAt) < Date.parse(r.window.start));
  assert.ok(Date.parse(added.publishedAt) >= Date.parse(r.widened[0].start) - 24 * 3_600_000);

  const nothingLeft = await client.post('/api/research/widen', { runId: r.runId, hours: 336 });
  assert.equal(nothingLeft.status, 400);
});

test('"Since last successful run": uses the saved marker, falls back to 24h with a note, clamps at 30 days', async (t) => {
  const { client } = await ready(t);
  const marker = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const r = await research(client, { mode: 'since_last', lastRunEnd: marker });
  assert.equal(r.window.effectiveMode, 'since_last');
  assert.equal(r.window.start, marker);

  const first = await research(client, { mode: 'since_last' });
  assert.equal(first.window.effectiveMode, '24h');
  assert.match(first.window.notes[0], /past 24 hours/);

  const old = await research(client, { mode: 'since_last', lastRunEnd: new Date(Date.now() - 90 * 86_400_000).toISOString() });
  assert.equal(old.window.clamped, true);
  assert.match(old.window.notes[0], /30 days/);
  assert.equal(Date.parse(old.window.end) - Date.parse(old.window.start), 30 * 86_400_000);

  const bad = await client.post('/api/research', { mode: 'whenever' });
  assert.equal(bad.status, 400);
});

test('a failed search keeps the marker where it was and says why; the run still completes with warnings', async (t) => {
  const { client } = await ready(t, {
    serp: { searchOverride: (q) => (/PeopleSoft HCM/.test(q) ? { status: 500, body: { error: 'boom' } } : null) },
  });
  const r = await research(client);
  assert.equal(r.failedSearches, 1);
  assert.equal(r.marker.advance, false);
  assert.match(r.marker.reason, /1 news search failed/);
  assert.ok(r.warnings.some((w) => /1 of 15 searches failed/.test(w)));
  assert.ok(r.ideas.length > 0);
});

test('a complete run advances the marker when every category quota is met', async (t) => {
  const { client } = await ready(t, {
    serp: {
      stories: {
        oracle: Array.from({ length: 3 }, (_, i) => ({ t: `Oracle story ${i}`, host: 'oracle.com', age: 2 + i })),
        peoplesoft: Array.from({ length: 3 }, (_, i) => ({ t: `PeopleSoft story ${i}`, host: 'psadmin.io', age: 3 + i })),
        general: Array.from({ length: 8 }, (_, i) => ({ t: `General story ${i}`, host: 'arxiv.org', age: 1 + i })),
      },
    },
  });
  const r = await research(client);
  assert.equal(r.ideas.length, 10);
  assert.equal(r.complete, true);
  assert.equal(r.marker.advance, true);
  assert.equal(r.marker.value, r.window.end);
  assert.ok(r.ideas.every((i) => i.sources.every((s) => typeof s.primary === 'boolean')));
  assert.ok(r.ideas.some((i) => i.sources.some((s) => s.primary)));
});

test('search errors: bad key and quota are fatal; rate limit surfaces with retry-after; total failure is search_failed', async (t) => {
  const fatal = await ready(t, { serp: { searchOverride: () => ({ status: 401, body: { error: 'Invalid API key.' } }) } });
  const r1 = await fatal.client.post('/api/research', { mode: '24h' });
  assert.equal(r1.status, 401);
  assert.equal(r1.json.error.code, 'invalid_serpapi_key');
  assert.ok(fatal.stack.serp.calls.filter((c) => c.path === '/search.json').length <= 4, 'stops early on a fatal error');

  const quota = await ready(t, { serp: { searchOverride: () => ({ status: 429, body: { error: 'Your account has run out of searches.' } }) } });
  const r2 = await quota.client.post('/api/research', { mode: '24h' });
  assert.equal(r2.status, 402);
  assert.equal(r2.json.error.code, 'quota_exhausted');

  const rl = await ready(t, { serp: { searchOverride: () => ({ status: 429, body: { error: 'Too many requests' }, headers: { 'retry-after': '9' } }) } });
  const r3 = await rl.client.post('/api/research', { mode: '24h' });
  assert.equal(r3.status, 429);
  assert.equal(r3.json.error.code, 'rate_limit');
  assert.equal(r3.json.error.retryAfter, 9);

  const down = await ready(t, { serp: { searchOverride: () => ({ status: 500, body: { error: 'oops' } }) } });
  const r4 = await down.client.post('/api/research', { mode: '24h' });
  assert.equal(r4.status, 502);
  assert.equal(r4.json.error.code, 'search_failed');
});

test('OpenAI quota exhaustion while generating ideas returns 402', async (t) => {
  const { client } = await ready(t, {
    openai: { respond: (task) => (task === 'research_ideas' ? httpResponse(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }) : undefined) },
  });
  const r = await client.post('/api/research', { mode: '24h' });
  assert.equal(r.status, 402);
  assert.equal(r.json.error.code, 'quota_exhausted');
});

test('a newer research run invalidates older ones', async (t) => {
  const { client } = await ready(t);
  const a = await research(client);
  const b = await research(client);
  assert.notEqual(a.runId, b.runId);
  const r = await client.post('/api/draft/x', { runId: a.runId, items: draftItems(a.ideas.slice(0, 1), () => ({ tweetCount: 3 })) });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'stale_run');
});

// ---------------------------------------------------------------------------
// drafting
// ---------------------------------------------------------------------------

async function approved(client, n = 3) {
  const r = await research(client);
  return { runId: r.runId, ideas: r.ideas.slice(0, n) };
}

test('LinkedIn: one post per idea, CTA only where given, server appends the source links', async (t) => {
  const { stack, client } = await ready(t);
  const { runId, ideas } = await approved(client);
  const cta = 'https://example.com/webinar';
  const res = await client.post('/api/draft/linkedin', {
    runId,
    items: draftItems(ideas, (_, i) => (i === 1 ? { ctaUrl: cta } : {})),
  });
  assert.equal(res.status, 200);
  const results = res.json.results;
  assert.equal(results.length, 3);
  for (const [i, r] of results.entries()) {
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.issues, []);
    const lines = r.draft.text.split('\n');
    for (const s of ideas[i].sources) assert.ok(lines.includes(s.url), 'source link present');
    if (i === 1) {
      assert.equal(lines.at(-1), cta, 'CTA URL alone on the last line');
      assert.ok(lines.at(-2).length > 10 && !lines.at(-2).includes('http'), 'a CTA line precedes it');
      assert.equal(r.draft.ctaUrl, cta);
    } else {
      assert.ok(!r.draft.text.includes(cta));
      assert.equal(r.draft.ctaUrl, null);
      assert.equal(r.draft.cta, '');
      assert.equal(lines.at(-1), ideas[i].sources.at(-1).url, 'without CTA the source links end the post');
    }
    assert.ok(r.draft.length <= 3000);
  }
  // prompts: standard verbatim, audience, no URLs for the model to copy, independent review call made
  const gen = stack.openai.calls.filter((c) => c.task === 'linkedin_draft');
  assert.equal(gen.length, 3);
  assert.ok(gen.every((c) => c.system.includes(WRITING_STANDARD)));
  assert.ok(gen.every((c) => /10-20 years of experience/.test(c.system)));
  assert.ok(gen.every((c) => !/https:\/\/(blogs|www)?\.?[a-z]+\.(com|io|org)\/mock-demo/.test(c.user)));
  const reviews = stack.openai.calls.filter((c) => c.task === 'linkedin_review');
  assert.equal(reviews.length, 3);
  assert.ok(reviews.every((c) => c.system.includes(WRITING_STANDARD) && c.system !== gen[0].system));
});

test('LinkedIn: invalid CTA URLs and bad items are rejected', async (t) => {
  const { client } = await ready(t);
  const { runId, ideas } = await approved(client);
  const one = (extra) => ({ runId, items: [{ ideaId: ideas[0].id, notes: '', ...extra }] });
  assert.equal((await client.post('/api/draft/linkedin', one({ ctaUrl: 'example.com/signup' }))).status, 400);
  assert.equal((await client.post('/api/draft/linkedin', one({ ctaUrl: 'javascript:alert(1)' }))).status, 400);
  assert.equal((await client.post('/api/draft/linkedin', one({ notes: 'x'.repeat(1001) }))).status, 400);
  assert.equal((await client.post('/api/draft/linkedin', { runId, items: [{ ideaId: 'idea-999' }] })).status, 400);
  assert.equal((await client.post('/api/draft/linkedin', { runId, items: [] })).status, 400);
  assert.equal((await client.post('/api/draft/linkedin', { runId, items: [{ ideaId: ideas[0].id }, { ideaId: ideas[0].id }] })).status, 400);
  assert.equal((await client.post('/api/draft/linkedin', { runId, items: ideas.concat(ideas).map((i) => ({ ideaId: i.id })) })).status, 400);
  const blank = await client.post('/api/draft/linkedin', one({ ctaUrl: '   ' }));
  assert.equal(blank.status, 200);
  assert.equal(blank.json.results[0].draft.ctaUrl, null);
});

test('X: tweet count is set independently per thread (1-25) and generated exactly', async (t) => {
  const { stack, client } = await ready(t);
  const { runId, ideas } = await approved(client);
  const counts = [1, 4, 25];
  const res = await client.post('/api/draft/x', { runId, items: draftItems(ideas, (_, i) => ({ tweetCount: counts[i] })) });
  assert.equal(res.status, 200);
  res.json.results.forEach((r, i) => {
    assert.equal(r.status, 'ok');
    assert.equal(r.draft.tweets.length, counts[i]);
    assert.deepEqual(r.issues, []);
    assert.ok(r.draft.tweets.every((tw) => tw.weight <= 280 && tw.weight === weightedLength(tw.text)));
    const urls = r.draft.tweets.flatMap((tw) => tw.text.match(/https:\/\/\S+/g) || []);
    assert.ok(urls.length >= 1 && urls.every((u) => ideas[i].sources.some((s) => s.url === u)), 'only provided https URLs');
  });
  const call = stack.openai.calls.find((c) => c.task === 'x_draft');
  assert.ok(call.system.includes(WRITING_STANDARD));
  assert.match(call.system, /San Francisco and the Bay Area/);

  for (const bad of [0, 26, 2.5, '3', null, undefined]) {
    const r = await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, tweetCount: bad }] });
    assert.equal(r.status, 400, String(bad));
  }
});

test('X: an over-long tweet is sent back for repair and the repaired thread is valid', async (t) => {
  const { stack, client } = await ready(t);
  const { runId, ideas } = await approved(client, 1);
  const res = await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, notes: '[mock:overlong]', tweetCount: 4 }] });
  assert.equal(res.status, 200);
  const r = res.json.results[0];
  assert.deepEqual(r.issues, []);
  assert.ok(r.draft.tweets.every((tw) => tw.weight <= 280));
  const repair = stack.openai.calls.filter((c) => c.task === 'x_repair');
  assert.equal(repair.length, 1);
  assert.deepEqual(repair[0].input.issues.map((i) => i.code), ['tweet_too_long']);
  assert.equal(repair[0].input.issues[0].tweetIndex, 1);
});

test('X: a draft that stays invalid after 4 repairs is returned with its issues, not hidden', async (t) => {
  const { stack, client } = await ready(t, {
    openai: {
      respond: (task, input, ctx) => {
        if (task === 'x_draft' || task === 'x_repair') {
          const out = ctx.default();
          out.tweets[1] = 'z'.repeat(400);
          return out;
        }
        return undefined;
      },
    },
  });
  const { runId, ideas } = await approved(client, 1);
  const res = await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, tweetCount: 3 }] });
  assert.equal(res.status, 200);
  const r = res.json.results[0];
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.issues.map((i) => i.code), ['tweet_too_long']);
  assert.equal(r.draft.tweets[1].weight, 400);
  assert.equal(stack.openai.calls.filter((c) => c.task === 'x_repair').length, 4);
});

test('repair call failure keeps the last usable draft with a visible warning', async (t) => {
  const { client } = await ready(t, {
    openai: { respond: (task) => (task === 'x_repair' ? httpResponse(500, { error: { message: 'down' } }) : undefined) },
  });
  const { runId, ideas } = await approved(client, 1);
  const res = await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, notes: '[mock:overlong]', tweetCount: 3 }] });
  assert.equal(res.status, 200);
  const r = res.json.results[0];
  assert.equal(r.status, 'ok');
  assert.equal(r.draft.tweets.length, 3);
  assert.ok(r.draft.tweets[1].weight > 280, 'original draft kept');
  assert.deepEqual(r.issues.map((i) => i.code), ['tweet_too_long']);
  assert.ok(r.warnings.some((w) => w.code === 'repair_failed'));
});

test('transient failures (bad JSON, empty output, 5xx) are retried without consuming a repair attempt', async (t) => {
  const seen = { n: 0 };
  const { stack, client } = await ready(t, {
    openai: {
      respond: (task) => {
        if (task !== 'x_draft') return undefined;
        seen.n++;
        if (seen.n === 1) return 'this is not json';
        if (seen.n === 2) return httpResponse(503, { error: { message: 'overloaded' } });
        return undefined;
      },
    },
  });
  const { runId, ideas } = await approved(client, 1);
  const res = await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, tweetCount: 3 }] });
  assert.equal(res.status, 200);
  assert.equal(res.json.results[0].status, 'ok');
  assert.deepEqual(res.json.results[0].issues, []);
  assert.equal(stack.openai.calls.filter((c) => c.task === 'x_draft').length, 3);
  assert.equal(stack.openai.calls.filter((c) => c.task === 'x_repair').length, 0);
});

test('an empty model answer is transient too, and three failures in a row surface the real error', async (t) => {
  const { client } = await ready(t, { openai: { respond: (task) => (task === 'x_draft' ? '' : undefined) } });
  const { runId, ideas } = await approved(client, 1);
  const res = await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, tweetCount: 3 }] });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, 'invalid_output');
});

test('hook review: a weak opening is rewritten and the rewrite is applied', async (t) => {
  const { stack, client } = await ready(t);
  const { runId, ideas } = await approved(client, 1);
  const [li, x] = await Promise.all([
    client.post('/api/draft/linkedin', { runId, items: [{ ideaId: ideas[0].id, notes: '[mock:weakhook]' }] }),
    client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, notes: '[mock:weakhook]', tweetCount: 3 }] }),
  ]);
  const l = li.json.results[0];
  assert.ok(l.warnings.some((w) => w.code === 'hook_rewritten'));
  assert.ok(!l.draft.hook.includes('Big news in tech today'));
  assert.ok(l.draft.text.startsWith(l.draft.hook));
  const xr = x.json.results[0];
  assert.ok(xr.warnings.some((w) => w.code === 'hook_rewritten'));
  assert.ok(!xr.draft.tweets[0].text.includes('Big news'));
  assert.deepEqual(xr.issues, []);
  assert.equal(stack.openai.calls.filter((c) => c.task === 'x_review').length, 1);
});

test('hook review: a rewrite that introduces a new validation issue is rejected; the original stays with a warning', async (t) => {
  const { client } = await ready(t, {
    openai: {
      respond: (task, input) => {
        if (task === 'linkedin_review') {
          return { standsAlone: false, reasonToKeepReading: true, bodySupportsClaim: true, notInterchangeable: true, problems: 'vague', rewrite: 'A sharper hook, see https://sneaky.example/page' };
        }
        if (task === 'x_review') {
          return { standsAlone: true, reasonToKeepReading: true, bodySupportsClaim: false, notInterchangeable: true, problems: 'unsupported', rewrite: 'z'.repeat(300) };
        }
        return undefined;
      },
    },
  });
  const { runId, ideas } = await approved(client, 1);
  const li = (await client.post('/api/draft/linkedin', { runId, items: [{ ideaId: ideas[0].id }] })).json.results[0];
  assert.ok(li.warnings.some((w) => w.code === 'hook_rewrite_rejected' && /url_in_text/.test(w.message)));
  assert.ok(li.warnings.some((w) => w.code === 'weak_opening'));
  assert.ok(!li.draft.text.includes('sneaky.example'));
  assert.deepEqual(li.issues, []);
  const x = (await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, tweetCount: 3 }] })).json.results[0];
  assert.ok(x.warnings.some((w) => w.code === 'hook_rewrite_rejected' && /tweet_too_long/.test(w.message)));
  assert.ok(!x.draft.tweets[0].text.startsWith('zzz'));
});

test('hook review: a self-reported "passes" is ignored; a failed review call only adds a warning', async (t) => {
  const { client } = await ready(t, {
    openai: {
      respond: (task) => {
        if (task === 'linkedin_review') return { passes: true, standsAlone: false, reasonToKeepReading: true, bodySupportsClaim: true, notInterchangeable: true, problems: 'x', rewrite: null };
        if (task === 'x_review') return httpResponse(500, { error: { message: 'down' } });
        return undefined;
      },
    },
  });
  const { runId, ideas } = await approved(client, 1);
  const li = (await client.post('/api/draft/linkedin', { runId, items: [{ ideaId: ideas[0].id }] })).json.results[0];
  assert.ok(li.warnings.some((w) => w.code === 'weak_opening'));
  const x = (await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[0].id, tweetCount: 2 }] })).json.results[0];
  assert.equal(x.status, 'ok');
  assert.ok(x.warnings.some((w) => w.code === 'review_failed'));
});

test('one agent can fail while the other succeeds, and their requests run at the same time', async (t) => {
  let xDuring = 0;
  let liDuring = 0;
  let overlapped = false;
  const { client } = await ready(t, {
    openai: {
      respond: async (task) => {
        if (task === 'linkedin_draft') {
          liDuring++;
          await new Promise((r) => setTimeout(r, 150));
          overlapped ||= xDuring > 0;
          liDuring--;
          return undefined;
        }
        if (task === 'x_draft') {
          xDuring++;
          await new Promise((r) => setTimeout(r, 150));
          overlapped ||= liDuring > 0;
          xDuring--;
          return httpResponse(500, { error: { message: 'x agent down' } });
        }
        return undefined;
      },
    },
  });
  const { runId, ideas } = await approved(client);
  const [li, x] = await Promise.all([
    client.post('/api/draft/linkedin', { runId, items: draftItems(ideas) }),
    client.post('/api/draft/x', { runId, items: draftItems(ideas, () => ({ tweetCount: 3 })) }),
  ]);
  assert.equal(li.status, 200);
  assert.ok(li.json.results.every((r) => r.status === 'ok'));
  assert.equal(x.status, 502);
  assert.equal(x.json.error.code, 'upstream_unavailable');
  assert.ok(overlapped, 'both agents were in flight together');
  // the failed agent can be retried independently
});

test('partial failure inside one agent: successful drafts are returned next to the failed one', async (t) => {
  const { client } = await ready(t, {
    openai: { respond: (task, input) => (task === 'linkedin_draft' && /FAILME/.test(input.idea.editorialNotes) ? httpResponse(429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, { 'retry-after': '3' }) : undefined) },
  });
  const { runId, ideas } = await approved(client);
  const res = await client.post('/api/draft/linkedin', { runId, items: draftItems(ideas, (_, i) => (i === 1 ? { notes: 'FAILME' } : {})) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.results.map((r) => r.status), ['ok', 'error', 'ok']);
  assert.equal(res.json.results[1].error.code, 'rate_limit');
  assert.equal(res.json.results[1].error.retryAfter, 3);
});

test('rate limit and quota while drafting return their real status', async (t) => {
  const rl = await ready(t, { openai: { respond: (task) => (task === 'linkedin_draft' ? httpResponse(429, { error: { message: 'slow', code: 'rate_limit_exceeded' } }, { 'retry-after': '5' }) : undefined) } });
  const a = await approved(rl.client, 2);
  const r1 = await rl.client.post('/api/draft/linkedin', { runId: a.runId, items: draftItems(a.ideas) });
  assert.equal(r1.status, 429);
  assert.equal(r1.json.error.code, 'rate_limit');
  assert.equal(r1.headers['retry-after'], '5');

  const q = await ready(t, { openai: { respond: (task) => (task === 'x_draft' ? httpResponse(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }) : undefined) } });
  const b = await approved(q.client, 1);
  const r2 = await q.client.post('/api/draft/x', { runId: b.runId, items: [{ ideaId: b.ideas[0].id, tweetCount: 2 }] });
  assert.equal(r2.status, 402);
  assert.equal(r2.json.error.code, 'quota_exhausted');
});

test('drafting without saved keys is refused', async (t) => {
  const stack = await withStack(t);
  const r = await stack.client().post('/api/draft/x', { runId: 'a', items: [] });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'keys_missing');
});

test('regenerating a single draft needs only that idea', async (t) => {
  const { client } = await ready(t);
  const { runId, ideas } = await approved(client);
  const res = await client.post('/api/draft/x', { runId, items: [{ ideaId: ideas[2].id, tweetCount: 7 }] });
  assert.equal(res.json.results.length, 1);
  assert.equal(res.json.results[0].ideaId, ideas[2].id);
  assert.equal(res.json.results[0].draft.tweets.length, 7);
});

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

test('no secret appears in logs, responses or error bodies across a whole flow', async (t) => {
  const { stack, client } = await ready(t, {
    openai: { respond: (task) => (task === 'x_draft' ? httpResponse(401, { error: { message: `Incorrect API key provided: ${OPENAI_KEY}`, code: 'invalid_api_key' } }) : undefined) },
  });
  const bodies = [];
  const r = await research(client);
  bodies.push(JSON.stringify(r));
  const li = await client.post('/api/draft/linkedin', { runId: r.runId, items: draftItems(r.ideas.slice(0, 3)) });
  bodies.push(li.text);
  const x = await client.post('/api/draft/x', { runId: r.runId, items: draftItems(r.ideas.slice(0, 1), () => ({ tweetCount: 3 })) });
  assert.equal(x.status, 401);
  assert.equal(x.json.error.code, 'invalid_openai_key');
  bodies.push(x.text);
  bodies.push((await client.put('/api/session/keys', { openaiKey: 'sk-bad-0123456789abcdef0123' })).text);
  bodies.push((await client.get('/api/session')).text);

  for (const secret of [OPENAI_KEY, SERP_KEY, 'sk-bad-0123456789abcdef0123']) {
    for (const b of bodies) assert.ok(!b.includes(secret), 'response leaked a key');
    assert.ok(!stack.logs.join('\n').includes(secret), 'log leaked a key');
  }
  assert.ok(!bodies.join('').includes(client.cookie.split('=')[1]), 'session id never returned in a body');
  // logs hold only method, path, status and duration
  assert.ok(stack.logs.length > 5);
  for (const line of stack.logs) assert.match(line, /^(GET|POST|PUT|DELETE|PATCH) \/api\/[a-z/]+ \d{3} \d+ms$/);
  assert.ok(!stack.logs.some((l) => l.includes('?')), 'query strings are never logged');
});
