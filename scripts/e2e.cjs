/* Browser verification with Playwright (Chromium) against the mock providers.
 *
 *   npm run build && npm run test:e2e            # production path: npm start
 *   E2E_TARGET=dev npm run test:e2e              # Vite dev middleware path
 *
 * Playwright is not a project dependency; it is resolved from the environment (NODE_PATH / global install).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'e2e-artifacts');
const TARGET = process.env.E2E_TARGET === 'dev' ? 'dev' : 'start';
const OPENAI_KEY = 'sk-e2e-openai-key-0123456789abcdef';
const SERP_KEY = 'e2e-serpapi-key-0123456789abcdef0123456789abcdef';

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not available in this environment (require("playwright") failed).');
  process.exit(2);
}

const results = [];
let failed = false;
async function step(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed = true;
    results.push(['FAIL', name]);
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function startApp(env) {
  const output = [];
  const args = TARGET === 'dev' ? ['./node_modules/vite/bin/vite.js', '--port', '0'] : ['server/index.js'];
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('app did not start:\n' + output.join(''))), 20000);
    const check = () => {
      const text = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
      const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(text);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', check);
    child.on('exit', (c) => reject(new Error(`app exited (${c}):\n${output.join('')}`)));
  });
  return { base, child, output };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { startMockOpenAI } = await import('../server/mock/openai.js');
  const { startMockSerpApi } = await import('../server/mock/serpapi.js');
  const openai = await startMockOpenAI();
  const serp = await startMockSerpApi();
  const app = await startApp({ OPENAI_BASE_URL: `${openai.url}/v1`, SERPAPI_BASE_URL: serp.url });
  console.log(`Target: ${TARGET} at ${app.base}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource.*(401|402|409|429|502|504)/.test(m.text())) pageErrors.push('console.error: ' + m.text());
  });
  page.on('dialog', (d) => d.accept());

  const sel = (id) => `[data-testid="${id}"]`;
  const approveFirst = async (n, offset = 0) => {
    const toggles = page.locator(`${sel('idea-card')} ${sel('approve-toggle')}`);
    for (let i = 0; i < n; i++) await toggles.nth(offset + i).click();
  };

  console.log('Key entry');
  await page.goto(app.base);
  await step('key panel opens first; keys are masked password fields with autocomplete off', async () => {
    await page.waitForSelector(sel('key-panel'));
    const fields = await page.$$eval('input[type=password]', (els) => els.map((e) => ({ ac: e.autocomplete, t: e.type })));
    assert(fields.length === 2 && fields.every((f) => f.ac === 'off'), JSON.stringify(fields));
    assert(await page.isDisabled(sel('run-research')), 'research is disabled without keys');
  });

  await step('a rejected key shows a clear error and is not echoed', async () => {
    const [o, s] = await page.$$('input[type=password]');
    await o.fill('sk-bad-openai-key-0123456789abcdef');
    await s.fill(SERP_KEY);
    await page.click('text=Save & verify');
    await page.waitForSelector(`${sel('key-panel')} ${sel('error-alert')}[data-code="invalid_openai_key"]`);
    const body = await page.content();
    assert(!body.includes('sk-bad-openai-key-0123456789abcdef') || (await o.inputValue()).length > 0, 'key only lives in the input');
    const alertText = await page.textContent(`${sel('key-panel')} ${sel('error-alert')}`);
    assert(!alertText.includes('sk-bad'), 'alert does not echo the key: ' + alertText);
  });

  await step('valid keys save, the panel closes and typed keys are cleared', async () => {
    const [o, s] = await page.$$('input[type=password]');
    await o.fill(OPENAI_KEY);
    await s.fill(SERP_KEY);
    await page.click('text=Save & verify');
    await page.waitForSelector(sel('key-panel'), { state: 'detached' });
    await page.click(sel('toggle-keys'));
    const vals = await page.$$eval('input[type=password]', (els) => els.map((e) => e.value));
    assert(vals.every((v) => v === ''), 'typed keys cleared after saving');
    await page.click('text=Close');
  });

  console.log('Research');
  await step('first run covers the past 24 hours, shows the local window and a PeopleSoft shortfall', async () => {
    await page.check('input[value="since_last"]');
    const hint = await page.textContent(sel('marker-hint'));
    assert(/No successful run is recorded yet/.test(hint), hint);
    await page.check('input[value="24h"]');
    await page.click(sel('run-research'));
    await page.waitForSelector(sel('shortfall'), { timeout: 20000 });
    const ideas = await page.locator(sel('idea-card')).count();
    assert(ideas === 9, `expected 9 ideas, got ${ideas}`);
    assert(/1 idea is missing/.test(await page.textContent(sel('shortfall'))));
    assert((await page.textContent(sel('quota-peoplesoft'))).includes('1/2'));
    assert(/\d{4}.*→.*\d{4}/.test(await page.textContent(sel('window'))), 'window displayed');
    assert(/not advanced/.test(await page.textContent(sel('marker-status'))), 'marker explained');
    const stored = await page.evaluate(() => localStorage.getItem('nsai.lastRunEnd'));
    assert(stored === null, 'marker not stored after an incomplete run');
    await page.locator(sel('research-panel')).screenshot({ path: path.join(OUT, 'research-panel-light.png') });
    await page.locator(sel('idea-card')).first().screenshot({ path: path.join(OUT, 'idea-card-light.png') });
  });

  await step('ideas show source-confirmed facts and our inference separately, with dated sources', async () => {
    const card = page.locator(sel('idea-card')).first();
    assert((await card.locator('.panel-confirmed h4').textContent()) === 'Confirmed by sources');
    assert((await card.locator('.panel-inference h4').textContent()) === 'Proposed application (our inference)');
    const src = await card.locator('.sources li').first().textContent();
    assert(/\d{4}/.test(src), 'publication date shown: ' + src);
    assert((await page.locator(`${sel('idea-card')} textarea`).count()) === 9, 'editorial notes per idea');
    assert(await page.isHidden(sel('start-drafting')) || (await page.isDisabled(sel('start-drafting'))), 'nothing can start yet');
  });

  await step('widening only the missing category keeps existing ideas and completes the run', async () => {
    const before = await page.locator(sel('idea-card')).evaluateAll((els) => els.map((e) => e.dataset.ideaId));
    await page.selectOption(sel('widen-select'), '168');
    await page.click(sel('widen'));
    await page.waitForSelector(sel('shortfall'), { state: 'detached', timeout: 20000 });
    const after = await page.locator(sel('idea-card')).evaluateAll((els) => els.map((e) => e.dataset.ideaId));
    assert(after.length === 10 && before.every((id) => after.includes(id)), 'kept: ' + after.join());
    assert(/Run complete/.test(await page.textContent(sel('marker-status'))));
    const keys = await page.evaluate(() => Object.keys(localStorage));
    assert(JSON.stringify(keys) === '["nsai.lastRunEnd"]', 'localStorage keys: ' + keys);
  });

  console.log('Approval');
  await step('exactly three ideas can be approved; the fourth is disabled; start needs three', async () => {
    await approveFirst(2);
    assert(await page.isDisabled(sel('start-drafting')), 'disabled with 2');
    await approveFirst(1, 2);
    const toggles = page.locator(`${sel('idea-card')} ${sel('approve-toggle')}`);
    assert(await toggles.nth(3).isDisabled(), '4th approve button disabled');
    assert(!(await page.isDisabled(sel('start-drafting'))), 'enabled with 3');
    assert(/3 of 3 approved/.test(await page.textContent(sel('approval-count'))));
  });

  await step('per-idea settings: tweet counts (1-25) and optional CTA URL; invalid values block start', async () => {
    const counts = page.locator(sel('tweet-count'));
    await counts.nth(0).fill('1');
    await counts.nth(1).fill('4');
    await counts.nth(2).fill('26');
    assert(await page.isDisabled(sel('start-drafting')), '26 tweets is refused');
    await counts.nth(2).fill('12');
    await page.locator(sel('cta-url')).nth(1).fill('example.com/nope');
    assert(await page.isDisabled(sel('start-drafting')), 'CTA without https:// is refused');
    await page.locator(sel('cta-url')).nth(1).fill('https://example.com/webinar');
    assert(!(await page.isDisabled(sel('start-drafting'))));
    const notes = page.locator(`${sel('idea-card')} textarea`);
    await notes.nth(0).fill('[mock:weakhook]');
    await notes.nth(1).fill('[mock:overlong]');
  });

  console.log('Parallel drafting');
  await step('both agents start together, show separate progress, then three posts and three threads', async () => {
    // slow responses a little so the running state is observable
    const first = page.locator(`${sel('idea-card')} textarea`).nth(2);
    await first.fill('[mock:delay=700] [mock:weakhook]');
    await page.click(sel('start-drafting'));
    await page.waitForSelector(`${sel('linkedin-section')}[data-state="running"]`, { timeout: 3000 });
    await page.waitForSelector(`${sel('x-section')}[data-state="running"]`, { timeout: 3000 });
    await page.waitForSelector(`${sel('linkedin-section')}[data-state="done"]`, { timeout: 20000 });
    await page.waitForSelector(`${sel('x-section')}[data-state="done"]`, { timeout: 20000 });
    assert((await page.locator(sel('linkedin-card')).count()) === 3);
    assert((await page.locator(sel('x-card')).count()) === 3);
    assert(await page.isHidden(sel('start-drafting')), 'approval panel is replaced by the drafts');
  });

  await step('X threads have the chosen tweet counts, all counters within 280 after repair', async () => {
    const cards = page.locator(sel('x-card'));
    const counts = [];
    for (let i = 0; i < 3; i++) counts.push(await cards.nth(i).locator(sel('tweet')).count());
    assert(JSON.stringify(counts) === '[1,4,12]', JSON.stringify(counts));
    assert((await page.locator(`${sel('tweet-counter')}.over`).count()) === 0, 'no red counters');
    for (const section of ['linkedin-section', 'x-section']) {
      const n = await page.locator(`${sel(section)} ${sel('draft-warning')}[data-code="hook_rewritten"]`).count();
      assert(n >= 1, `weak hook rewritten and flagged in ${section}`);
    }
    assert((await page.locator(`${sel('x-section')} ${sel('draft-issue')}`).count()) === 0, 'no outstanding issues after repair');
  });

  await step('LinkedIn: CTA only where entered; sources appended; copy controls work', async () => {
    const posts = page.locator(sel('linkedin-text'));
    const t0 = await posts.nth(0).inputValue();
    const t1 = await posts.nth(1).inputValue();
    assert(t1.trim().split('\n').pop() === 'https://example.com/webinar', 'CTA URL alone on last line');
    assert(!t0.includes('example.com/webinar'));
    assert(/Sources:\n(https:\/\/\S+\n?)+/.test(t0), 'source links appended');
    await page.locator(sel('copy-post')).nth(1).click();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === t1, 'copy post');
    await page.locator(sel('copy-thread')).nth(1).click();
    const thread = await page.evaluate(() => navigator.clipboard.readText());
    const tweets = await page.locator(sel('x-card')).nth(1).locator('textarea').evaluateAll((els) => els.map((e) => e.value));
    assert(thread === tweets.slice(0, 4).join('\n\n'), 'copy thread');
    await page.locator(sel('x-card')).nth(1).locator(sel('copy-tweet')).nth(1).click();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === tweets[1], 'copy tweet');
  });

  await step('editing a tweet past 280 turns its live counter red', async () => {
    const ta = page.locator(sel('x-card')).nth(1).locator('textarea').first();
    await ta.fill('x'.repeat(285));
    const counter = page.locator(sel('x-card')).nth(1).locator(sel('tweet-counter')).first();
    assert(/285\/280.*too long/.test(await counter.textContent()), await counter.textContent());
    assert((await counter.getAttribute('class')).includes('over'));
    await ta.fill('short');
    assert(!(await counter.getAttribute('class')).includes('over'));
  });

  await step('light-theme screenshots', async () => {
    await page.locator(sel('linkedin-card')).nth(1).screenshot({ path: path.join(OUT, 'linkedin-card-light.png') });
    await page.locator(sel('x-card')).nth(1).screenshot({ path: path.join(OUT, 'x-card-light.png') });
  });

  console.log('Failure handling');
  await step('one agent failing leaves the other intact; retry failed fixes only the failed one', async () => {
    await page.route('**/api/draft/x', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'upstream_unavailable', message: 'OpenAI returned a temporary error (503).', hint: 'Retry in a moment.' } }) }));
    await page.click(sel('x-regen-all'));
    await page.waitForSelector(`${sel('x-section')}[data-state="attention"]`);
    assert((await page.locator(`${sel('x-section')} ${sel('error-alert')}`).count()) === 3, 'each thread shows the error');
    assert((await page.locator(sel('x-card')).first().locator('textarea').count()) >= 1, 'previous drafts preserved');
    assert((await page.locator(sel('linkedin-section')).getAttribute('data-state')) === 'done', 'LinkedIn unaffected');
    await page.unroute('**/api/draft/x');
    await page.click(sel('x-retry'));
    await page.waitForSelector(`${sel('x-section')}[data-state="done"]`, { timeout: 20000 });
    assert((await page.locator(`${sel('x-section')} ${sel('error-alert')}`).count()) === 0);
  });

  await step('regenerate one draft only touches that draft', async () => {
    const before = await page.locator(sel('linkedin-text')).evaluateAll((els) => els.map((e) => e.value));
    await page.locator(sel('linkedin-regen')).nth(2).click();
    await page.waitForSelector(`${sel('linkedin-card')}[data-state="running"]`, { timeout: 3000 }).catch(() => {});
    await page.waitForSelector(`${sel('linkedin-section')}[data-state="done"]`, { timeout: 20000 });
    const after = await page.locator(sel('linkedin-text')).evaluateAll((els) => els.map((e) => e.value));
    assert(after[0] === before[0] && after[1] === before[1], 'other posts untouched');
  });

  console.log('Discard while in flight');
  await step('discarding drafts mid-run is safe: late responses are ignored and nothing reappears', async () => {
    await page.click(sel('discard'));
    await page.waitForSelector(sel('linkedin-section'), { state: 'detached' });
    const toggles = page.locator(`${sel('idea-card')} ${sel('approve-toggle')}`);
    // ideas unlock after a discard; 3 are still approved
    assert((await toggles.nth(0).textContent()).includes('Approved'));
    const notes = page.locator(`${sel('idea-card')} textarea`);
    for (let i = 0; i < 3; i++) await notes.nth(i).fill('[mock:delay=1500]');
    await page.click(sel('start-drafting'));
    await page.waitForSelector(`${sel('linkedin-section')}[data-state="running"]`);
    await page.click(sel('discard')); // no draft is done yet, so no confirm dialog
    await page.waitForSelector(sel('linkedin-section'), { state: 'detached' });
    await page.waitForTimeout(3500); // let the delayed responses arrive
    assert((await page.locator(sel('linkedin-card')).count()) === 0 && (await page.locator(sel('x-card')).count()) === 0, 'stale responses ignored');
    assert(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
  });

  await step('a new research run while drafting is in flight is safe too', async () => {
    const notes = page.locator(`${sel('idea-card')} textarea`);
    for (let i = 0; i < 3; i++) await notes.nth(i).fill('[mock:delay=1200]');
    await page.click(sel('start-drafting'));
    await page.waitForSelector(`${sel('linkedin-section')}[data-state="running"]`);
    await page.click(sel('run-research'));
    await page.waitForSelector(sel('linkedin-section'), { state: 'detached' });
    await page.waitForSelector(sel('shortfall'), { timeout: 20000 });
    await page.waitForTimeout(2000);
    assert((await page.locator(sel('linkedin-card')).count()) === 0);
    assert(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
  });

  console.log('Reload, key errors and storage');
  await step('after a reload the saved keys are still in use (server memory) and the last-run time is offered', async () => {
    await page.reload();
    await page.waitForSelector(sel('toggle-keys'));
    assert((await page.textContent(sel('toggle-keys'))) === 'Edit API keys');
    assert(await page.isHidden(sel('key-panel')), 'no key prompt');
    assert(!(await page.isDisabled(sel('run-research'))));
    await page.check('input[value="since_last"]');
    assert(/Last successful run ended/.test(await page.textContent(sel('marker-hint'))));
  });

  await step('a key error offers "Edit API keys" which opens the key panel', async () => {
    await page.route('**/api/research', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_serpapi_key', message: 'SerpAPI rejected the API key.', hint: 'Check the SerpAPI key and save it again with Edit API keys.' } }) }));
    await page.click(sel('run-research'));
    const alert = page.locator(`${sel('error-alert')}[data-code="invalid_serpapi_key"]`);
    await alert.waitFor();
    await alert.getByRole('button', { name: 'Edit API keys' }).click();
    await page.waitForSelector(sel('key-panel'));
    await page.unroute('**/api/research');
    await page.click('text=Close');
  });

  await step('rate-limit errors display the retry hint', async () => {
    await page.route('**/api/research', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'rate_limit', message: 'OpenAI is rate limiting requests. Retry in about 11s.', retryAfter: 11, hint: 'Wait a moment and retry.' } }) }));
    await page.click(sel('run-research'));
    const alert = page.locator(`${sel('error-alert')}[data-code="rate_limit"]`);
    await alert.waitFor();
    assert(/Retry in about 11s/.test(await alert.textContent()));
    await page.unroute('**/api/research');
  });

  await step('credentials are nowhere in the browser: storage, cookies visible to JS, DOM, bundle', async () => {
    const dump = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
      cookie: document.cookie,
      html: document.documentElement.outerHTML,
      idb: indexedDB.databases ? 1 : 0,
    }));
    for (const secret of [OPENAI_KEY, SERP_KEY]) {
      assert(!dump.local.includes(secret) && !dump.session.includes(secret) && !dump.cookie.includes(secret) && !dump.html.includes(secret), 'secret in page');
    }
    assert(dump.session === '{}', 'sessionStorage empty');
    assert(!/nsai_sid/.test(dump.cookie), 'session cookie is HttpOnly');
    const cookies = await context.cookies();
    const sid = cookies.find((c) => c.name === 'nsai_sid');
    assert(sid && sid.httpOnly && sid.sameSite === 'Strict', JSON.stringify(sid));
    assert(!sid.value.includes(OPENAI_KEY));
  });

  await step('the server output never contains a key', async () => {
    const text = app.output.join('');
    assert(!text.includes(OPENAI_KEY) && !text.includes(SERP_KEY), 'secret in server output');
  });

  console.log('Layout and themes');
  await step('no horizontal scroll at 390px, in light and dark themes, with drafts on screen', async () => {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(app.base);
      await p.waitForSelector(sel('key-panel'));
      const [o, s] = await p.$$('input[type=password]');
      await o.fill(OPENAI_KEY);
      await s.fill(SERP_KEY);
      await p.click('text=Save & verify');
      await p.waitForSelector(sel('key-panel'), { state: 'detached' });
      await p.click(sel('run-research'));
      await p.waitForSelector(sel('shortfall'), { timeout: 20000 });
      await p.selectOption(sel('widen-select'), '168');
      await p.click(sel('widen'));
      await p.waitForSelector(sel('shortfall'), { state: 'detached', timeout: 20000 });
      const toggles = p.locator(`${sel('idea-card')} ${sel('approve-toggle')}`);
      for (let i = 0; i < 3; i++) await toggles.nth(i).click();
      await p.locator(sel('cta-url')).nth(0).fill('https://example.com/a-fairly-long-call-to-action-url/with/many/segments?and=params');
      await p.click(sel('start-drafting'));
      await p.waitForSelector(`${sel('x-section')}[data-state="done"]`, { timeout: 20000 });
      await p.waitForSelector(`${sel('linkedin-section')}[data-state="done"]`, { timeout: 20000 });
      const widths = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
      assert(widths.doc <= widths.inner && widths.body <= widths.inner, `${scheme}: horizontal overflow ${JSON.stringify(widths)}`);
      const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert(scheme === 'dark' ? bg === 'rgb(14, 17, 23)' : bg === 'rgb(246, 247, 249)', `${scheme} theme background ${bg}`);
      await p.locator(sel('idea-card')).first().screenshot({ path: path.join(OUT, `mobile-idea-${scheme}.png`) });
      await p.locator(sel('x-card')).first().screenshot({ path: path.join(OUT, `mobile-x-${scheme}.png`) });
      assert(errs.length === 0, errs.join('|'));
      await ctx.close();
    }
  });

  await step('after the server forgets the keys, the key error offers Edit API keys and the panel shows the real status', async () => {
    const p = await context.newPage();
    await p.goto(app.base);
    await p.waitForSelector(sel('toggle-keys'));
    assert((await p.textContent(sel('toggle-keys'))) === 'Edit API keys', 'page loaded believing keys are saved');
    // the server now loses them (as after a restart) while the page still believes they exist
    await p.evaluate(() => fetch('/api/session', { method: 'DELETE' }));
    await p.click(sel('run-research'));
    const alert = p.locator(`${sel('error-alert')}[data-code="keys_missing"]`);
    await alert.waitFor();
    await alert.getByRole('button', { name: 'Edit API keys' }).click();
    await p.waitForSelector(sel('key-panel'));
    await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="key-panel"] .chip')].every((c) => c.textContent === 'not set'));
    await p.close();
  });

  await step('no page errors during the whole run', async () => {
    assert(pageErrors.length === 0, pageErrors.join(' | '));
  });

  await browser.close();
  app.child.kill();
  await openai.close();
  await serp.close();

  const bundleDir = path.join(root, 'dist', 'assets');
  if (TARGET === 'start' && fs.existsSync(bundleDir)) {
    await step('the built bundle contains no credentials', async () => {
      for (const f of fs.readdirSync(bundleDir)) {
        const text = fs.readFileSync(path.join(bundleDir, f), 'utf8');
        assert(!text.includes(OPENAI_KEY) && !text.includes(SERP_KEY), `${f} contains a test key`);
        assert(!/sk-[A-Za-z0-9_-]{20,}/.test(text), `${f} contains an sk- style key`);
        assert(!/VITE_[A-Z_]*(KEY|TOKEN|SECRET)/.test(text), `${f} references a VITE_ credential`);
        assert(!/api_key=/.test(text), `${f} builds provider URLs with api_key`);
      }
    });
  }

  const bad = results.filter(([s]) => s !== 'ok').length;
  console.log(`\n${results.length - bad}/${results.length} browser checks passed (${TARGET}).`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
