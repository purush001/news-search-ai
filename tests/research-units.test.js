import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleIdeas, capCandidates, collectCandidates, computeWindow, parseMarker, quotaStatus, isPrimaryHost } from '../server/research.js';
import { normalizeUrl } from '../shared/index.js';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const H = 3_600_000;

function cand(id, { cats = ['general'], url, primary = false, time = NOW - H, title } = {}) {
  const u = url || `https://news.example.com/${id}`;
  return { id, key: normalizeUrl(u), title: title || `Story ${id}`, url: u, source: 'example', host: 'news.example.com', primary, time, precision: 'time', snippet: 's', categories: new Set(cats) };
}
const byId = (...cs) => new Map(cs.map((c) => [c.id, c]));
const raw = (over = {}) => ({ category: 'general', headline: 'H', summary: 'S', angle: 'A', confirmed: 'C', application: 'Inference: x', sourceIds: ['c1'], ...over });
const QUOTAS = { oracle: 2, peoplesoft: 2, general: 6 };

test('assembleIdeas enforces category quotas and drops the excess', () => {
  const cs = Array.from({ length: 4 }, (_, i) => cand(`c${i + 1}`, { cats: ['oracle'] }));
  const { ideas, dropped } = assembleIdeas(
    cs.map((c, i) => raw({ category: 'oracle', headline: `Head ${i}`, sourceIds: [c.id] })),
    byId(...cs),
    { quotas: QUOTAS },
  );
  assert.equal(ideas.length, 2);
  assert.deepEqual(dropped.map((d) => d.reason), ['over_quota', 'over_quota']);
});

test('assembleIdeas ignores unknown source ids and requires at least one valid dated source', () => {
  const c1 = cand('c1');
  const out = assembleIdeas([raw({ sourceIds: ['c1', 'zzz'] }), raw({ headline: 'Other', sourceIds: ['nope'] }), raw({ headline: 'Third', sourceIds: [] })], byId(c1), { quotas: QUOTAS });
  assert.equal(out.ideas.length, 1);
  assert.equal(out.ideas[0].sources.length, 1);
  assert.deepEqual(out.dropped.map((d) => d.reason), ['no_valid_sources', 'no_valid_sources']);
});

test('URLs come from candidates; URLs the model writes into text are stripped', () => {
  const c1 = cand('c1', { url: 'https://real.example.com/story' });
  const { ideas } = assembleIdeas(
    [raw({ headline: 'Look at https://evil.example/phish now', summary: 'See www.evil.com for more. Real text.', sourceIds: ['c1'], url: 'https://evil.example', sources: [{ url: 'https://evil.example' }] })],
    byId(c1),
    { quotas: QUOTAS },
  );
  const idea = ideas[0];
  assert.deepEqual(idea.sources.map((s) => s.url), ['https://real.example.com/story']);
  assert.ok(!/evil/.test(JSON.stringify(idea)));
  assert.match(idea.summary, /Real text/);
});

test('repeated stories are removed (shared source URL or headline)', () => {
  const c1 = cand('c1', { url: 'https://a.example.com/x?utm_source=feed' });
  const c2 = cand('c2', { url: 'https://www.a.example.com/x' });
  const c3 = cand('c3');
  const c4 = cand('c4');
  const { ideas, dropped } = assembleIdeas(
    [
      raw({ headline: 'First', sourceIds: ['c1'] }),
      raw({ headline: 'Different headline, same page', sourceIds: ['c2'] }),
      raw({ headline: 'Third', sourceIds: ['c3'] }),
      raw({ headline: ' third! ', sourceIds: ['c4'] }),
    ],
    byId(c1, c2, c3, c4),
    { quotas: QUOTAS },
  );
  assert.deepEqual(ideas.map((i) => i.headline), ['First', 'Third']);
  assert.deepEqual(dropped.map((d) => d.reason), ['duplicate_story', 'duplicate_story']);
});

test('overlapping candidates are assigned to exactly one category; unsupported categories are dropped', () => {
  const both = cand('c1', { cats: ['oracle', 'general'] });
  const { ideas, dropped } = assembleIdeas(
    [raw({ category: 'oracle', headline: 'A', sourceIds: ['c1'] }), raw({ category: 'general', headline: 'B', sourceIds: ['c1'] }), raw({ category: 'peoplesoft', headline: 'C', sourceIds: ['c1'] })],
    byId(both),
    { quotas: QUOTAS },
  );
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].category, 'oracle');
  assert.deepEqual(dropped.map((d) => d.reason), ['duplicate_story', 'category_unsupported']);
});

test('assembleIdeas rejects malformed entries without throwing', () => {
  const out = assembleIdeas([null, 'x', 5, {}, raw({ category: 'sports' }), raw({ headline: '' })], byId(cand('c1')), { quotas: QUOTAS });
  assert.equal(out.ideas.length, 0);
  assert.equal(out.dropped.length, 6);
  assert.equal(assembleIdeas(undefined, new Map(), { quotas: QUOTAS }).ideas.length, 0);
});

test('assembleIdeas against existing ideas keeps quotas and numbering when filling a shortfall', () => {
  const c1 = cand('c1', { cats: ['peoplesoft'] });
  const c2 = cand('c2', { cats: ['peoplesoft'] });
  const c3 = cand('c3', { cats: ['peoplesoft'] });
  const first = assembleIdeas([raw({ category: 'peoplesoft', headline: 'One', sourceIds: ['c1'] })], byId(c1), { quotas: QUOTAS });
  const fill = assembleIdeas(
    [raw({ category: 'peoplesoft', headline: 'Two', sourceIds: ['c2'] }), raw({ category: 'peoplesoft', headline: 'Three', sourceIds: ['c3'] })],
    byId(c2, c3),
    { quotas: { oracle: 0, peoplesoft: 1, general: 0 }, existing: first.ideas, nextNumber: 2 },
  );
  assert.equal(fill.ideas.length, 1);
  assert.equal(fill.ideas[0].id, 'idea-2');
  assert.equal(quotaStatus([...first.ideas, ...fill.ideas]).peoplesoft.missing, 0);
});

test('capCandidates balances categories round-robin, primary first then newest', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(cand(`g${i}`, { cats: ['general'], time: NOW - i * H, primary: i === 7 }));
  list.push(cand('o1', { cats: ['oracle'] }), cand('o2', { cats: ['oracle'] }), cand('o3', { cats: ['oracle'] }));
  list.push(cand('p1', { cats: ['peoplesoft'] }), cand('p2', { cats: ['peoplesoft'] }));
  const capped = capCandidates(list, 12);
  assert.equal(capped.length, 12);
  const ids = capped.map((c) => c.id);
  for (const id of ['o1', 'o2', 'o3', 'p1', 'p2']) assert.ok(ids.includes(id), `${id} must survive the cap`);
  assert.equal(capped.filter((c) => c.categories.has('general')).length, 7);
  assert.equal(ids.indexOf('g7') < ids.indexOf('g0'), true, 'primary source first');
  assert.ok(ids.includes('g1') && ids.includes('g0'));
  assert.ok(!ids.includes('g19'));
});

test('capCandidates does not select a multi-category candidate twice', () => {
  const both = cand('x', { cats: ['oracle', 'general'] });
  const capped = capCandidates([both, cand('o', { cats: ['oracle'] })], 10);
  assert.equal(capped.filter((c) => c.id === 'x').length, 1);
});

test('collectCandidates: local date filter, undated ignored, URL dedupe merges categories', () => {
  const start = NOW - 24 * H;
  const item = (url, dateRaw, title = 't') => ({ title, url, source: 's', dateRaw, snippet: '' });
  const { candidates, stats } = collectCandidates(
    [
      { category: 'oracle', item: item('https://a.example.com/1?utm_source=x', '3 hours ago') },
      { category: 'general', item: item('https://www.a.example.com/1', '3 hours ago') },
      { category: 'general', item: item('https://b.example.com/old', '5 days ago') },
      { category: 'general', item: item('https://b.example.com/none', null) },
      { category: 'general', item: item('https://b.example.com/garbage', 'Wed, 05 Nov 2026 10:00:00 GMT') },
      { category: 'general', item: item('javascript:alert(1)', '1 hour ago') },
      { category: 'general', item: item('https://c.example.com/dayonly', '2026-11-04') },
    ],
    { start, end: NOW, now: NOW },
  );
  assert.equal(candidates.length, 2);
  const merged = candidates.find((c) => c.url.includes('a.example.com'));
  assert.deepEqual([...merged.categories].sort(), ['general', 'oracle']);
  assert.deepEqual({ undated: stats.undated, outside: stats.outside, invalid: stats.invalid }, { undated: 2, outside: 1, invalid: 1 });
});

test('primary hosts include subdomains but not look-alikes', () => {
  assert.equal(isPrimaryHost('blogs.oracle.com'), true);
  assert.equal(isPrimaryHost('www.arxiv.org'), true);
  assert.equal(isPrimaryHost('notoracle.com'), false);
  assert.equal(isPrimaryHost('oracle.com.evil.example'), false);
});

test('computeWindow: 24h, since-last, missing marker, future marker and 30-day clamp', () => {
  const w24 = computeWindow({ mode: '24h', now: NOW });
  assert.equal(w24.start, NOW - 24 * H);
  assert.equal(w24.effectiveMode, '24h');

  const marker = new Date(NOW - 5 * H).toISOString();
  const since = computeWindow({ mode: 'since_last', lastRunEnd: marker, now: NOW });
  assert.equal(since.start, NOW - 5 * H);
  assert.equal(since.effectiveMode, 'since_last');
  assert.equal(since.notes.length, 0);

  const missing = computeWindow({ mode: 'since_last', lastRunEnd: undefined, now: NOW });
  assert.equal(missing.effectiveMode, '24h');
  assert.equal(missing.start, NOW - 24 * H);
  assert.match(missing.notes[0], /24 hours/);

  const junk = computeWindow({ mode: 'since_last', lastRunEnd: 'yesterday-ish', now: NOW });
  assert.equal(junk.effectiveMode, '24h');

  const future = computeWindow({ mode: 'since_last', lastRunEnd: new Date(NOW + H).toISOString(), now: NOW });
  assert.equal(future.effectiveMode, '24h');

  const old = computeWindow({ mode: 'since_last', lastRunEnd: new Date(NOW - 90 * 24 * H).toISOString(), now: NOW });
  assert.equal(old.clamped, true);
  assert.equal(old.start, NOW - 30 * 24 * H);
  assert.match(old.notes[0], /30 days/);
});

test('parseMarker is strict', () => {
  assert.ok(parseMarker('2026-11-05T10:00:00.000Z'));
  assert.equal(parseMarker('2026-11-05'), null);
  assert.equal(parseMarker('Nov 5 2026'), null);
  assert.equal(parseMarker(12345), null);
});

test('plain domain mentions in idea text stay readable; only links are stripped', () => {
  const c1 = cand('c1');
  const { ideas } = assembleIdeas([raw({ summary: 'Reported by blogs.oracle.com today, see https://x.example/a.', sourceIds: ['c1'] })], byId(c1), { quotas: QUOTAS });
  assert.equal(ideas[0].summary, 'Reported by blogs.oracle.com today, see.');
});
