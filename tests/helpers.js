import http from 'node:http';
import { createApi } from '../server/app.js';
import { createAppServer } from '../server/index.js';
import { startMockOpenAI } from '../server/mock/openai.js';
import { startMockSerpApi } from '../server/mock/serpapi.js';
import { listen } from '../server/mock/util.js';

export const OPENAI_KEY = 'sk-test-openai-key-0123456789abcdef';
export const SERP_KEY = 'serp-test-key-0123456789abcdef0123456789abcdef';

/** Raw HTTP request (lets tests set Host/Origin freely, which fetch does not). */
export function rawRequest(base, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A tiny client with a cookie jar, talking to the real HTTP server. */
export function createClient(base) {
  let cookie = '';
  const client = {
    get cookie() {
      return cookie;
    },
    async request(method, path, body, extraHeaders = {}) {
      const headers = { ...extraHeaders };
      if (cookie) headers.cookie = cookie;
      let payload;
      if (body !== undefined) {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
        headers['content-type'] ??= 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }
      const res = await rawRequest(base, { method, path, headers, body: payload });
      const set = res.headers['set-cookie'];
      if (set?.length) {
        const first = set[0].split(';')[0];
        cookie = first.endsWith('=') ? '' : first;
      }
      return res;
    },
    get: (p, h) => client.request('GET', p, undefined, h),
    post: (p, b, h) => client.request('POST', p, b, h),
    put: (p, b, h) => client.request('PUT', p, b, h),
    del: (p, h) => client.request('DELETE', p, undefined, h),
    async saveKeys(openaiKey = OPENAI_KEY, serpapiKey = SERP_KEY) {
      const r = await client.put('/api/session/keys', { openaiKey, serpapiKey });
      if (r.status !== 200) throw new Error(`saveKeys failed: ${r.status} ${r.text}`);
      return r;
    },
  };
  return client;
}

export async function startStack({ openai = {}, serp = {}, config = {} } = {}) {
  const mockOpenAI = await startMockOpenAI(openai);
  const mockSerp = await startMockSerpApi(serp);
  const logs = [];
  const api = createApi({
    openaiBaseUrl: `${mockOpenAI.url}/v1`,
    serpapiBaseUrl: mockSerp.url,
    logger: (l) => logs.push(l),
    openaiTimeoutMs: 5000,
    serpTimeoutMs: 5000,
    ...config,
  });
  const server = createAppServer({ api, distDir: new URL('./nonexistent-dist', import.meta.url).pathname });
  const handle = await listen(server);
  return {
    base: handle.url,
    api,
    logs,
    openai: mockOpenAI,
    serp: mockSerp,
    client: () => createClient(handle.url),
    async close() {
      await Promise.all([handle.close(), mockOpenAI.close(), mockSerp.close()]);
    },
  };
}

/** Runs the default research flow and returns the response body. */
export async function research(client, body = { mode: '24h' }) {
  const r = await client.post('/api/research', body);
  if (r.status !== 200) throw new Error(`research failed: ${r.status} ${r.text}`);
  return r.json;
}
