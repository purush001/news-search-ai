import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { rawRequest } from './helpers.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);

async function startServer(t) {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'nsai-dist-'));
  await mkdir(path.join(dist, 'assets'));
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>t</title><div id="root"></div>');
  await writeFile(path.join(dist, 'assets', 'app-1.js'), 'console.log(1)');
  await writeFile(path.join(dist, 'secret.txt'), 'inside dist');
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', DIST_DIR: dist }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  t.after(async () => {
    child.kill();
    await rm(dist, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + output.join(''))), 8000);
    child.stdout.on('data', () => {
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output.join(''));
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${output.join('')}`)));
  });
  return { base, child, output };
}

test('standalone server serves the app and survives malformed paths', async (t) => {
  const { base, child } = await startServer(t);

  const home = await rawRequest(base, { path: '/' });
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);

  for (const bad of ['/%', '/%E0%A4%A', '/foo/%zz', '/assets/%']) {
    const r = await rawRequest(base, { path: bad });
    assert.equal(r.status, 400, bad);
  }
  assert.equal(child.exitCode, null, 'process is still running after malformed paths');

  const asset = await rawRequest(base, { path: '/assets/app-1.js' });
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.match(asset.headers['cache-control'], /immutable/);

  assert.equal((await rawRequest(base, { path: '/missing.js' })).status, 404);
  assert.equal((await rawRequest(base, { path: '/some/client/route' })).status, 200, 'SPA fallback');
  assert.equal((await rawRequest(base, { method: 'POST', path: '/', headers: { 'content-length': '0' } })).status, 405);
  const traversal = await rawRequest(base, { path: '/%2e%2e/%2e%2e/etc/passwd' });
  assert.ok(!/root:/.test(traversal.text), 'path traversal never leaves dist');
  assert.equal((await rawRequest(base, { path: '/%2e%2e/%2e%2e/etc/passwd.txt' })).status, 404);
  assert.equal((await rawRequest(base, { path: '/%00' })).status, 400);
  assert.equal((await rawRequest(base, { path: '/api/%' })).status, 404);

  // API is served by the same process
  const session = await rawRequest(base, { path: '/api/session' });
  assert.equal(session.status, 200);
  assert.equal(session.json.hasOpenAI, false);

  // a garbage request line must not kill it either
  await new Promise((resolve) => {
    const s = net.connect(Number(new URL(base).port), '127.0.0.1', () => s.write('NOT HTTP AT ALL\r\n\r\n'));
    s.on('data', () => {});
    s.on('close', resolve);
    s.on('error', resolve);
    setTimeout(() => s.destroy(), 500);
  });
  assert.equal(child.exitCode, null);
  assert.equal((await rawRequest(base, { path: '/' })).status, 200);
});

test('standalone server binds to 127.0.0.1 only', async (t) => {
  const { output } = await startServer(t);
  assert.match(output.join(''), /127\.0\.0\.1/);
});
