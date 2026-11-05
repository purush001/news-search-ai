// One regression test per code-review finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { COOKIE_NAME } from '../server/sessions.js';
import { startStack, OPENAI_KEY, SERP_KEY } from './helpers.js';
import { httpResponse } from '../server/mock/openai.js';
import { listen } from '../server/mock/util.js';
import { effectiveWidenHours, searchedHours, widenChoices } from '../src/widen.js';
import { annotateSkipped, clearNotices, hasFinishedDrafts, partitionBySettings } from '../src/drafting.js';
import { withTransientRetry } from '../server/retry.js';
import { AppError } from '../server/errors.js';
import { ideaForModel, sourceUrls } from '../server/drafting/common.js';

const H = 3_600_000;
const END = Date.UTC(2026, 10, 5, 12);

test('widen select: the value displayed is the value sent, even after an earlier widen', () => {
  const research = {
    window: { start: new Date(END - 24 * H).toISOString(), end: new Date(END).toISOString() },
    widened: [{ start: new Date(END - 168 * H).toISOString() }],
  };
  assert.equal(searchedHours(research), 168);
  const choices = widenChoices(research);
  assert.deepEqual(choices, [336, 720]);
  // component state still holds the old default of 168, which is no longer offered
  assert.equal(effectiveWidenHours(choices, 168), 336);
  assert.equal(effectiveWidenHours(choices, 720), 720);
  const fresh = { window: research.window, widened: [] };
  assert.deepEqual(widenChoices(fresh), [48, 168, 336, 720]);
  assert.equal(effectiveWidenHours(widenChoices(fresh), 168), 168);
  assert.deepEqual(widenChoices({ window: research.window, widened: [{ start: new Date(END - 720 * H).toISOString() }] }), []);
});

test('batch regenerate skips drafts whose settings are invalid instead of failing the batch', () => {
  const settings = {
    a: { tweetCount: 5, ctaUrl: '' },
    b: { tweetCount: NaN, ctaUrl: 'nonsense' },
    c: { tweetCount: 30, ctaUrl: 'https://example.com/x' },
  };
  assert.deepEqual(partitionBySettings('x', ['a', 'b', 'c'], settings), { valid: ['a'], invalid: ['b', 'c'] });
  assert.deepEqual(partitionBySettings('linkedin', ['a', 'b', 'c'], settings), { valid: ['a', 'c'], invalid: ['b'] });
});

async function stallingServer() {
  const server = http.createServer((req, res) => {
    // headers and a partial body arrive, then the provider goes quiet
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{"id":');
  });
  return listen(server);
}

test('a provider that stalls after sending headers times out instead of hanging', async (t) => {
  const stall = await stallingServer();
  t.after(() => stall.close());
  const stack = await startStack({ config: { openaiBaseUrl: `${stall.url}/v1`, serpapiBaseUrl: stall.url, verifyTimeoutMs: 250 } });
  t.after(() => stack.close());
  const started = Date.now();
  const openai = await stack.client().put('/api/session/keys', { openaiKey: OPENAI_KEY });
  assert.equal(openai.status, 504);
  assert.equal(openai.json.error.code, 'timeout');
  const serp = await stack.client().put('/api/session/keys', { serpapiKey: SERP_KEY });
  assert.equal(serp.status, 504);
  assert.equal(serp.json.error.provider, 'serpapi');
  assert.ok(Date.now() - started < 3000, 'returned promptly');
});

test('a 4xx that rejects the request itself is request_rejected, not "unusable output", and is not retried', async (t) => {
  const stack = await startStack({
    openai: {
      respond: (task) =>
        task === 'research_ideas'
          ? httpResponse(400, { error: { message: "Unsupported parameter: 'response_format'", type: 'invalid_request_error', code: 'unsupported_parameter' } })
          : undefined,
    },
  });
  t.after(() => stack.close());
  const client = stack.client();
  await client.saveKeys();
  const r = await client.post('/api/research', { mode: '24h' });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'request_rejected');
  assert.match(r.json.error.hint, /OPENAI_MODEL/);
  assert.match(r.json.error.detail, /response_format/);
  assert.equal(stack.openai.calls.filter((c) => c.task === 'research_ideas').length, 1, 'not retried');
});

test('drafting agents see URLs only where needed: X yes, LinkedIn no; one shared helper', () => {
  const src = (title) => ({ title, url: 'https://a.example/x', source: 'a.example', publishedAt: '2026-11-05T10:00:00.000Z', primary: true });
  const idea = { headline: 'h', summary: 's', angle: 'a', confirmed: 'c', application: 'i', sources: [src('t'), src('t2')] };
  assert.ok(!JSON.stringify(ideaForModel(idea, 'n')).includes('https://'));
  assert.equal(ideaForModel(idea, 'n', { withUrls: true }).sources[0].url, 'https://a.example/x');
  assert.deepEqual(sourceUrls(idea), ['https://a.example/x']);
  assert.equal(ideaForModel(idea, undefined).editorialNotes, '');
});

test('engines.node is a pinned major, new enough for the test glob, and package-lock agrees', async () => {
  const read = async (f) => JSON.parse(await readFile(new URL(f, import.meta.url), 'utf8'));
  const pkg = await read('../package.json');
  const lock = await read('../package-lock.json');
  // Vercel maps open ranges such as ">=22" to the newest Node, so only "<major>.x" is accepted.
  assert.match(pkg.engines.node, /^\d+\.x$/, `engines.node "${pkg.engines.node}" must be a pinned major like 22.x`);
  const major = Number(/(\d+)/.exec(pkg.engines.node)[1]);
  if (/\*/.test(pkg.scripts.test)) assert.ok(major >= 21, `engines ${pkg.engines.node} cannot expand test globs`);
  assert.equal(lock.packages[''].engines.node, pkg.engines.node, 'package-lock.json must match package.json');
});

test('research keeps only what widening and drafting need in session memory', async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const client = stack.client();
  await client.saveKeys();
  await client.post('/api/research', { mode: '24h' });
  const sid = client.cookie.split('=')[1];
  assert.ok(client.cookie.startsWith(`${COOKIE_NAME}=`));
  const research = stack.api.sessions.get(sid).research;
  assert.deepEqual(Object.keys(research).sort(), ['failedSearches', 'ideas', 'nextNumber', 'runId', 'warnings', 'widened', 'window']);
});

test('transient retries back off (delay, then double) and never wait after the last try or for non-transient errors', async () => {
  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);
  let n = 0;
  await assert.rejects(
    withTransientRetry(async () => { n++; throw new AppError('timeout', 'x'); }, { retries: 2, delayMs: 100, sleep }),
    (e) => e.code === 'timeout',
  );
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [100, 200]);

  sleeps.length = 0;
  n = 0;
  await assert.rejects(withTransientRetry(async () => { n++; throw new AppError('rate_limit', 'x'); }, { retries: 2, delayMs: 100, sleep }));
  assert.equal(n, 1);
  assert.deepEqual(sleeps, []);

  n = 0;
  const ok = await withTransientRetry(async () => { if (++n < 2) throw new AppError('upstream_unavailable', 'x'); return 'fine'; }, { retries: 2, delayMs: 50, sleep });
  assert.equal(ok, 'fine');
  assert.deepEqual(sleeps, [50]);
});

test('the real retry path waits between tries when configured', async (t) => {
  let n = 0;
  const stack = await startStack({
    config: { retryDelayMs: 120 },
    openai: { respond: (task) => (task === 'x_draft' && ++n <= 2 ? httpResponse(503, { error: { message: 'busy' } }) : undefined) },
  });
  t.after(() => stack.close());
  const client = stack.client();
  await client.saveKeys();
  const r = (await client.post('/api/research', { mode: '24h' })).json;
  const started = Date.now();
  const res = await client.post('/api/draft/x', { runId: r.runId, items: [{ ideaId: r.ideas[0].id, tweetCount: 2 }] });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started >= 120 + 240 - 30, `waited between retries (${Date.now() - started}ms)`);
});

test('a draft that exceeds its time budget keeps the last usable draft, skips repairs and review, and says so', async (t) => {
  let t0 = 0;
  const stack = await startStack({
    config: { draftBudgetMs: 1000, budgetClock: () => (t0 += 5000) }, // every look at the clock is 5s later
  });
  t.after(() => stack.close());
  const client = stack.client();
  await client.saveKeys();
  const r = (await client.post('/api/research', { mode: '24h' })).json;
  const res = await client.post('/api/draft/x', { runId: r.runId, items: [{ ideaId: r.ideas[0].id, notes: '[mock:overlong]', tweetCount: 3 }] });
  assert.equal(res.status, 200);
  const item = res.json.results[0];
  assert.equal(item.status, 'ok');
  assert.deepEqual(item.issues.map((i) => i.code), ['tweet_too_long']);
  assert.ok(item.warnings.some((w) => w.code === 'time_budget_exceeded'));
  assert.equal(stack.openai.calls.filter((c) => c.task === 'x_repair' || c.task === 'x_review').length, 0);
});

test('a restricted key (missing scope) is a key problem, not a model problem', async (t) => {
  const stack = await startStack({ openai: { modelsNeedScope: true } });
  t.after(() => stack.close());
  const r = await stack.client().put('/api/session/keys', { openaiKey: OPENAI_KEY });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'invalid_openai_key');
  assert.match(r.json.error.message, /permissions/);
  assert.match(r.json.error.hint, /Edit API keys/);
  assert.ok(!/OPENAI_MODEL/.test(r.text));
});

test('skipped-draft notices are notices (not errors), clear when the setting changes, and never touch other ideas', () => {
  const items = { a: { status: 'ok', draft: { x: 1 } }, b: { status: 'ok', draft: { x: 2 } } };
  const annotated = annotateSkipped(items, ['a'], 'Not regenerated: fix the tweet count first.');
  assert.equal(annotated.a.notice, 'Not regenerated: fix the tweet count first.');
  assert.equal(annotated.a.error, undefined);
  assert.equal(annotated.a.status, 'ok');
  assert.equal(annotated.b.notice, undefined);
  assert.equal(items.a.notice, undefined, 'input not mutated');

  const drafts = { linkedin: { items: annotated }, x: { items: { a: { status: 'ok', notice: 'n' }, b: { status: 'ok' } } } };
  const cleared = clearNotices(drafts, 'a');
  assert.equal(cleared.linkedin.items.a.notice, null);
  assert.equal(cleared.x.items.a.notice, null);
  assert.equal(cleared.linkedin.items.b.notice, undefined);
  assert.equal(clearNotices(drafts, 'zzz').linkedin, drafts.linkedin, 'unrelated ids leave state untouched');
});

test('hasFinishedDrafts is what guards every discard path', () => {
  assert.equal(hasFinishedDrafts(null), false);
  const running = { linkedin: { items: { a: { status: 'running' } } }, x: { items: { a: { status: 'running' } } } };
  assert.equal(hasFinishedDrafts(running), false);
  const errored = { linkedin: { items: { a: { status: 'error' } } }, x: { items: { a: { status: 'running' } } } };
  assert.equal(hasFinishedDrafts(errored), false);
  const one = { linkedin: { items: { a: { status: 'running' } } }, x: { items: { a: { status: 'ok' } } } };
  assert.equal(hasFinishedDrafts(one), true);
});
