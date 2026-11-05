import test from 'node:test';
import assert from 'node:assert/strict';
import { weightedLength as w, findUrls, X } from '../shared/index.js';

test('plain ASCII counts 1 per character with a 280 boundary', () => {
  assert.equal(w('a'.repeat(280)), 280);
  assert.equal(w('a'.repeat(281)), 281);
  assert.ok(w('a'.repeat(280)) <= X.tweetLimit);
  assert.ok(w('a'.repeat(281)) > X.tweetLimit);
});

test('every URL counts 23 regardless of length', () => {
  assert.equal(w('https://example.com'), 23);
  assert.equal(w('https://example.com/' + 'x'.repeat(500)), 23);
  assert.equal(w('Read https://example.com/a?b=c#d now'), 5 + 23 + 4);
  assert.equal(w('http://a.io/x https://b.org/y'), 23 + 1 + 23);
});

test('trailing punctuation is not part of the URL', () => {
  assert.equal(w('See https://example.com.'), 4 + 23 + 1);
  assert.equal(w('(https://example.com/a)'), 1 + 23 + 1);
});

test('scheme-less domains with a known TLD count 23', () => {
  assert.equal(w('see example.com'), 4 + 23);
  assert.equal(w('docs at oracle.com/ai now'), 8 + 23 + 4);
  assert.equal(w('example.co.uk'), 23);
});

test('Node.js, v8.62, versions and emails are not URLs', () => {
  assert.equal(w('Node.js'), 7);
  assert.equal(w('v8.62'), 5);
  assert.equal(w('Python 3.12.1'), 13);
  assert.equal(w('e.g. this'), 9);
  assert.equal(w('mail bob@example.com'), 20);
  assert.equal(findUrls('Node.js and v8.62 and bob@example.com').length, 0);
});

test('CJK counts 2 per character', () => {
  assert.equal(w('日本語'), 6);
  assert.equal(w('a日'), 3);
  assert.equal(w('日'.repeat(140)), 280);
  assert.equal(w('日'.repeat(141)), 282);
});

test('emoji count 2, ZWJ sequences, flags and keycaps count once', () => {
  assert.equal(w('😀'), 2);
  assert.equal(w('👨‍👩‍👧'), 2);
  assert.equal(w('🇺🇸'), 2);
  assert.equal(w('1️⃣'), 2);
  assert.equal(w('👍🏽'), 2);
  assert.equal(w('hi 😀'), 5);
});

test('special ranges: curly quotes and dashes weigh 1, ellipsis weighs 2', () => {
  assert.equal(w('it’s'), 4);
  assert.equal(w('a—b'), 3);
  assert.equal(w('…'), 2);
});

test('combining characters are normalized (NFC) before counting', () => {
  assert.equal(w('é'), 1);
  assert.equal(w('é'), 1);
});

test('URL next to emoji and CJK', () => {
  assert.equal(w('🚀 https://example.com 日本'), 2 + 1 + 23 + 1 + 4);
});
