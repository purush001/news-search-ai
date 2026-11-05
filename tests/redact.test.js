import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../server/redact.js';

test('redacts OpenAI-style keys, api_key params, bearer tokens and long hex keys', () => {
  const k = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  assert.ok(!redact(`bad key ${k} here`).includes(k));
  assert.ok(!redact('GET /search.json?q=x&api_key=SECRETVALUE123&num=1').includes('SECRETVALUE123'));
  assert.ok(!redact('Authorization: Bearer abcdef1234567890token').includes('abcdef1234567890token'));
  const hex = 'a'.repeat(64);
  assert.ok(!redact(`key=${hex}`).includes(hex));
  assert.ok(!redact('cookie nsai_sid=abc123def456').includes('abc123def456'));
});

test('does not mangle ordinary words such as "Risk-based" or "task-force"', () => {
  assert.equal(redact('Risk-based approach to task-force disk-usage and ask-me-anything-long-words'), 'Risk-based approach to task-force disk-usage and ask-me-anything-long-words');
});

test('redacts exact secrets supplied by the caller', () => {
  assert.equal(redact('token=shortsecret!', ['shortsecret!']), 'token=[redacted]');
});
