import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedinAdapter as li, assemble } from '../server/drafting/linkedin.js';
import { xAdapter as xa } from '../server/drafting/x.js';
import { WRITING_STANDARD, LINKEDIN_SYSTEM, X_SYSTEM, REVIEW_SYSTEM } from '../server/prompts.js';
import { normalizeVerdict } from '../server/drafting/runner.js';
import { LINKEDIN } from '../shared/index.js';

const idea = {
  id: 'idea-1',
  headline: 'Oracle ships X',
  summary: 'S',
  angle: 'A',
  confirmed: 'C',
  application: 'Inference: I',
  sources: [
    { title: 't1', url: 'https://oracle.com/a', source: 'oracle.com', publishedAt: '2026-11-05T10:00:00.000Z', primary: true },
    { title: 't2', url: 'https://arxiv.org/abs/1', source: 'arxiv.org', publishedAt: '2026-11-05T09:00:00.000Z', primary: true },
  ],
};
const good = { hook: 'A specific hook about the change.', body: 'b'.repeat(500), cta: '' };
const codes = (issues) => issues.map((i) => i.code);

test('writing standard is verbatim in both agent prompts and the review prompt', () => {
  for (const sys of [LINKEDIN_SYSTEM, X_SYSTEM, REVIEW_SYSTEM]) assert.ok(sys.includes(WRITING_STANDARD));
  assert.match(WRITING_STANDARD, /six-second hook/);
  assert.match(WRITING_STANDARD, /rewrite any opening that could fit several unrelated stories\.$/);
});

test('LinkedIn: a good draft has no issues; server appends the real source links', () => {
  const item = { idea, notes: '', ctaUrl: null };
  assert.deepEqual(li.validate(good, item), []);
  const text = assemble(good, item);
  assert.ok(text.endsWith('https://oracle.com/a\nhttps://arxiv.org/abs/1'));
});

test('LinkedIn: CTA line then URL alone on the last line; sources stay', () => {
  const item = { idea, notes: '', ctaUrl: 'https://example.com/signup' };
  const draft = { ...good, cta: 'Join the session.' };
  assert.deepEqual(li.validate(draft, item), []);
  const lines = assemble(draft, item).split('\n');
  assert.equal(lines.at(-1), 'https://example.com/signup');
  assert.equal(lines.at(-2), 'Join the session.');
  assert.ok(lines.includes('https://oracle.com/a'));
  assert.deepEqual(codes(li.validate({ ...good, cta: '' }, item)), ['cta_missing']);
});

test('LinkedIn: parse drops the CTA when no CTA URL was entered', () => {
  const parsed = li.parse({ hook: 'h', body: 'b', cta: 'Click here' }, { ctaUrl: null });
  assert.equal(parsed.cta, '');
  assert.throws(() => li.parse({ hook: 'h' }, { ctaUrl: null }), (e) => e.code === 'invalid_output' && e.transient);
});

test('LinkedIn issue codes: hook, body, urls and total length', () => {
  const item = { idea, notes: '', ctaUrl: null };
  assert.ok(codes(li.validate({ ...good, hook: '' }, item)).includes('hook_missing'));
  assert.ok(codes(li.validate({ ...good, hook: 'a\nb\nc' }, item)).includes('hook_too_many_lines'));
  assert.ok(codes(li.validate({ ...good, hook: 'x'.repeat(LINKEDIN.hookMaxChars + 1) }, item)).includes('hook_too_long'));
  assert.ok(codes(li.validate({ ...good, body: 'short' }, item)).includes('body_too_short'));
  assert.ok(codes(li.validate({ ...good, body: 'b'.repeat(LINKEDIN.bodyMaxChars + 1) }, item)).includes('body_too_long'));
  assert.ok(codes(li.validate({ ...good, body: good.body + ' see https://x.example.com/a' }, item)).includes('url_in_text'));
  assert.ok(codes(li.validate({ ...good, body: good.body + ' see oracle.com' }, item)).includes('url_in_text'));
  // body within its own cap but assembled post over 3,000 characters
  const longSources = { ...idea, sources: Array.from({ length: 4 }, (_, i) => ({ ...idea.sources[0], url: `https://oracle.com/${'p'.repeat(150)}${i}` })) };
  const tooLong = li.validate({ ...good, body: 'b'.repeat(LINKEDIN.bodyMaxChars) }, { idea: longSources, ctaUrl: 'https://example.com/' + 'q'.repeat(200) });
  assert.ok(codes(tooLong).includes('post_too_long'));
});

const xitem = (n) => ({ idea, notes: '', tweetCount: n });
const U = 'https://oracle.com/a';

test('X: valid thread passes; count, empty, over-limit, foreign URL, bare domain, missing source link', () => {
  assert.deepEqual(xa.validate({ tweets: ['hook', `detail ${U}`] }, xitem(2)), []);
  assert.deepEqual(codes(xa.validate({ tweets: ['a', `b ${U}`] }, xitem(3))), ['tweet_count']);
  assert.ok(codes(xa.validate({ tweets: ['', `b ${U}`] }, xitem(2))).includes('tweet_empty'));
  assert.ok(codes(xa.validate({ tweets: ['a'.repeat(281), U] }, xitem(2))).includes('tweet_too_long'));
  assert.ok(codes(xa.validate({ tweets: [`a ${U} https://other.example/x`] }, xitem(1))).includes('url_not_provided'));
  assert.ok(codes(xa.validate({ tweets: [`a oracle.com ${U}`] }, xitem(1))).includes('bare_domain'));
  assert.deepEqual(codes(xa.validate({ tweets: ['a', 'b'] }, xitem(2))), ['source_link_missing']);
});

test('X: 280 boundary is by weight, with URLs counting 23', () => {
  const pad = (n) => 'a'.repeat(n);
  assert.deepEqual(xa.validate({ tweets: [`${pad(280 - 24)} ${U}`] }, xitem(1)), []); // 256 + space + 23 = 280
  assert.deepEqual(codes(xa.validate({ tweets: [`${pad(280 - 23)} ${U}`] }, xitem(1))), ['tweet_too_long']);
  assert.deepEqual(xa.validate({ tweets: [`${'日'.repeat(128)} ${U}`] }, xitem(1)), []); // 256 + 1 + 23
  const issues = xa.validate({ tweets: ['ok', 'a'.repeat(300), U] }, xitem(3));
  assert.equal(issues.find((i) => i.code === 'tweet_too_long').at, 1);
});

test('X: thread length 1 and 25 are accepted by the validator', () => {
  assert.deepEqual(xa.validate({ tweets: [`one tweet ${U}`] }, xitem(1)), []);
  const tweets = Array.from({ length: 25 }, (_, i) => (i === 24 ? `end ${U}` : `t${i}`));
  assert.deepEqual(xa.validate({ tweets }, xitem(25)), []);
});

test('X: finalize reports weights and applyRewrite swaps only the first tweet', () => {
  const out = xa.finalize({ tweets: ['日本', `x ${U}`] }, xitem(2));
  assert.deepEqual(out.tweets.map((t) => t.weight), [4, 2 + 23]);
  assert.deepEqual(xa.applyRewrite({ tweets: ['a', 'b'] }, '  new  ').tweets, ['new', 'b']);
});

test('normalizeVerdict never trusts a self-reported pass', () => {
  assert.equal(normalizeVerdict({ passes: true, standsAlone: true, reasonToKeepReading: true, bodySupportsClaim: true, notInterchangeable: false }).passes, false);
  assert.equal(normalizeVerdict({ standsAlone: true, reasonToKeepReading: true, bodySupportsClaim: true, notInterchangeable: true }).passes, true);
  assert.equal(normalizeVerdict({ standsAlone: 'yes', reasonToKeepReading: true, bodySupportsClaim: true, notInterchangeable: true }).passes, false);
  assert.equal(normalizeVerdict({ rewrite: '   ' }).rewrite, null);
  assert.throws(() => normalizeVerdict(null));
});
