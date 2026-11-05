import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApi } from '../server/app.js';
import { createVercelHandler } from '../server/vercel.js';
import { startMockOpenAI } from '../server/mock/openai.js';
import { startMockSerpApi } from '../server/mock/serpapi.js';
import { listen } from '../server/mock/util.js';
import { createClient, OPENAI_KEY, SERP_KEY } from './helpers.js';

const PUBLIC_HOST = 'my-app.vercel.app';
const hostedHeaders = { host: PUBLIC_HOST, origin: `https://${PUBLIC_HOST}` };

/** Simulates Vercel's body helper: the JSON body is parsed and the stream consumed before the handler runs. */
function preParse(handler) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      let raw = '';
      for await (const c of req) raw += c;
      try {
        req.body = raw ? JSON.parse(raw) : undefined;
      } catch {
        req.body = raw; // Vercel leaves unparseable bodies as strings
      }
    }
    return handler(req, res);
  };
}

async function hostedStack(t, { preParsed = false, config = {} } = {}) {
  const openai = await startMockOpenAI();
  const serp = await startMockSerpApi();
  const api = createApi({
    openaiBaseUrl: `${openai.url}/v1`,
    serpapiBaseUrl: serp.url,
    allowAnyHost: true,
    secureCookies: true,
    retryDelayMs: 5,
    logger: () => {},
    ...config,
  });
  let handler = createVercelHandler(api);
  if (preParsed) handler = preParse(handler);
  const server = await listen(http.createServer(handler));
  t.after(() => Promise.all([server.close(), openai.close(), serp.close()]));
  return { base: server.url, client: createClient(server.url, hostedHeaders), openai, serp };
}

test('hosted: the public Host name is accepted and the whole flow works through the function adapter', async (t) => {
  const { client } = await hostedStack(t);
  const saved = await client.put('/api/session/keys', { openaiKey: OPENAI_KEY, serpapiKey: SERP_KEY });
  assert.equal(saved.status, 200);
  assert.match(saved.headers['set-cookie'][0], /HttpOnly/);
  assert.match(saved.headers['set-cookie'][0], /SameSite=Strict/);
  assert.match(saved.headers['set-cookie'][0], /; Secure/, 'HTTPS-only cookie when hosted');

  const r = await client.post('/api/research', { mode: '24h' });
  assert.equal(r.status, 200);
  assert.ok(r.json.ideas.length >= 9);
  const draft = await client.post('/api/draft/x', { runId: r.json.runId, items: [{ ideaId: r.json.ideas[0].id, tweetCount: 3 }] });
  assert.equal(draft.status, 200);

  const cleared = await client.del('/api/session');
  assert.match(cleared.headers['set-cookie'][0], /Max-Age=0.*|Max-Age=0/);
  assert.match(cleared.headers['set-cookie'][0], /Secure/);
});

test('hosted: cross-origin writes are still refused, even though any Host is allowed', async (t) => {
  const { client, base } = await hostedStack(t);
  const body = { openaiKey: OPENAI_KEY, serpapiKey: SERP_KEY };
  const evil = await client.put('/api/session/keys', body, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.json.error.code, 'forbidden_origin');
  const noOrigin = createClient(base, { host: PUBLIC_HOST });
  const site = await noOrigin.put('/api/session/keys', body, { 'sec-fetch-site': 'cross-site' });
  assert.equal(site.status, 403);
  assert.equal((await client.get('/api/session')).json.hasOpenAI, false);
});

test('hosted: JSON bodies that the platform already parsed (stream consumed) still work', async (t) => {
  const { client } = await hostedStack(t, { preParsed: true });
  const saved = await client.put('/api/session/keys', { openaiKey: OPENAI_KEY, serpapiKey: SERP_KEY });
  assert.equal(saved.status, 200, saved.text);
  const r = await client.post('/api/research', { mode: '24h' });
  assert.equal(r.status, 200, r.text);
  const arr = await client.post('/api/research', '[1,2]');
  assert.equal(arr.status, 400);
  const junk = await client.post('/api/research', '{oops');
  assert.equal(junk.status, 400);
  const big = await client.post('/api/research', JSON.stringify({ mode: '24h', pad: 'x'.repeat(100_000) }));
  assert.equal(big.status, 413);
});

test('a non-API path on the function adapter returns a JSON 404, and nothing thrown escapes', async (t) => {
  const { base } = await hostedStack(t);
  const res = await createClient(base, hostedHeaders).get('/not-api');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'not_found');
});

test('local defaults are unchanged: loopback Host only and no Secure flag', async (t) => {
  const openai = await startMockOpenAI();
  const serp = await startMockSerpApi();
  const api = createApi({ openaiBaseUrl: `${openai.url}/v1`, serpapiBaseUrl: serp.url, logger: () => {} });
  const server = await listen(http.createServer(createVercelHandler(api)));
  t.after(() => Promise.all([server.close(), openai.close(), serp.close()]));
  assert.equal(api.config.allowAnyHost, false);
  assert.equal(api.config.secureCookies, false);
  const foreign = await createClient(server.url, { host: PUBLIC_HOST }).get('/api/session');
  assert.equal(foreign.status, 403);
  const ok = await createClient(server.url).put('/api/session/keys', { openaiKey: OPENAI_KEY, serpapiKey: SERP_KEY });
  assert.equal(ok.status, 200);
  assert.ok(!/Secure/.test(ok.headers['set-cookie'][0]));
});

test('VERCEL=1 turns on hosted defaults', async () => {
  const before = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    const { loadConfig } = await import('../server/config.js');
    const c = loadConfig();
    assert.equal(c.allowAnyHost, true);
    assert.equal(c.secureCookies, true);
  } finally {
    if (before === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = before;
  }
});

test('vercel.json serves the same security headers as npm start, and routes the API function', async () => {
  const { readFile } = await import('node:fs/promises');
  const { SECURITY_HEADERS } = await import('../server/static.js');
  const cfg = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const configured = Object.fromEntries(cfg.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key.toLowerCase(), h.value]));
  assert.deepEqual(configured, SECURITY_HEADERS);
  assert.ok(cfg.functions['api/[...path].js'].maxDuration >= 30, 'research needs more than the 10s default');
  const { access } = await import('node:fs/promises');
  await access(new URL('../api/[...path].js', import.meta.url));
});
