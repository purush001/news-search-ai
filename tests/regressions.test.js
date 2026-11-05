// One regression test per code-review finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { startStack, OPENAI_KEY, SERP_KEY } from './helpers.js';
import { httpResponse } from '../server/mock/openai.js';
import { listen } from '../server/mock/util.js';
import { effectiveWidenHours, searchedHours, widenChoices } from '../src/widen.js';
import { partitionBySettings } from '../src/drafting.js';
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

test('engines.node is new enough for the node --test glob the test script uses', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const major = Number(/(\d+)/.exec(pkg.engines.node)[1]);
  if (/\*/.test(pkg.scripts.test)) assert.ok(major >= 21, `engines ${pkg.engines.node} cannot expand test globs`);
});

test('research does not keep every collected candidate in session memory', async () => {
  const src = await readFile(new URL('../server/research.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('allCandidates'));
});
