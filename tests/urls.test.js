import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidHttpUrl, normalizeUrl, normalizeHeadline } from '../shared/index.js';

test('isValidHttpUrl accepts real http(s) URLs only', () => {
  assert.ok(isValidHttpUrl('https://example.com/path?x=1'));
  assert.ok(isValidHttpUrl('http://example.com'));
  for (const bad of ['', 'example.com', 'ftp://example.com', 'javascript:alert(1)', 'https://localhost', 'https://user:pw@example.com', 'https://exa mple.com', 'https://', null, 5, 'https://' + 'a'.repeat(2100) + '.com']) {
    assert.equal(isValidHttpUrl(bad), false, String(bad).slice(0, 40));
  }
});

test('normalizeUrl ignores www, scheme, fragments, tracking params, trailing slash and param order', () => {
  const a = normalizeUrl('https://www.Example.com/a/b/?utm_source=x&b=2&a=1#frag');
  const b = normalizeUrl('http://example.com/a/b?a=1&b=2&fbclid=zzz');
  assert.equal(a, b);
  assert.notEqual(normalizeUrl('https://example.com/a'), normalizeUrl('https://example.com/b'));
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(normalizeUrl('ftp://example.com/x'), null);
});

test('normalizeHeadline folds case and punctuation', () => {
  assert.equal(normalizeHeadline('  Oracle: AI, Now! '), normalizeHeadline('oracle ai now'));
});
