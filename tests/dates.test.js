import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublished as p, isInWindow, representativeTime } from '../server/dates.js';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const H = 3_600_000;

test('ISO date-times (Z, offsets, fractions)', () => {
  assert.equal(p('2026-11-05T10:00:00Z', NOW).start, Date.UTC(2026, 10, 5, 10));
  assert.equal(p('2026-11-05T10:00:00+02:00', NOW).start, Date.UTC(2026, 10, 5, 8));
  assert.equal(p('2026-11-05T10:00:00.250Z', NOW).start, Date.UTC(2026, 10, 5, 10, 0, 0, 250));
  assert.equal(p('2026-11-05 10:00', NOW).precision, 'time');
});

test('ISO date-only has day precision spanning the UTC day', () => {
  const r = p('2026-11-04', NOW);
  assert.equal(r.precision, 'day');
  assert.equal(r.start, Date.UTC(2026, 10, 4));
  assert.equal(r.end, Date.UTC(2026, 10, 5) - 1);
});

test('SerpAPI absolute format', () => {
  assert.equal(p('11/05/2026, 07:30 AM, +0000 UTC', NOW).start, Date.UTC(2026, 10, 5, 7, 30));
  assert.equal(p('11/05/2026, 12:15 AM, +0000 UTC', NOW).start, Date.UTC(2026, 10, 5, 0, 15));
  assert.equal(p('11/05/2026, 01:00 PM, +0000 UTC', NOW).start, Date.UTC(2026, 10, 5, 13));
});

test('absolute month names', () => {
  assert.equal(p('Nov 3, 2026', NOW).start, Date.UTC(2026, 10, 3));
  assert.equal(p('November 3, 2026', NOW).start, Date.UTC(2026, 10, 3));
  assert.equal(p('3 Nov 2026', NOW).start, Date.UTC(2026, 10, 3));
  assert.equal(p('Sept 9, 2026', NOW).start, Date.UTC(2026, 8, 9));
});

test('relative forms are floored intervals', () => {
  const r = p('3 hours ago', NOW);
  assert.equal(r.end, NOW - 3 * H);
  assert.equal(r.start, NOW - 4 * H);
  assert.equal(p('a day ago', NOW).end, NOW - 24 * H);
  assert.equal(p('2 weeks ago', NOW).end, NOW - 14 * 24 * H);
  assert.equal(p('1 hr ago', NOW).precision, 'relative');
  assert.ok(p('yesterday', NOW));
});

test('strictness: garbage and lenient Date.parse inputs are rejected', () => {
  for (const bad of [
    '', 'garbage', '2026', '2026-02-30', '2026-13-01', '2026-11-05T25:00:00Z', '2026-11-05T10:61:00Z',
    'Nov 5', 'Nov 31, 2026', 'Foo 3, 2026', '5 Smarch 2026', 'tomorrow', 'in 3 hours', '3 hours', 'ago 3 hours',
    '13/45/2026, 07:30 AM, +0000 UTC', '11/05/2026, 13:30 AM, +0000 UTC', 'Wed, 05 Nov 2026 10:00:00 GMT',
    '12', '2026-11-05T10:00:00+25:00', null, undefined, 42, 'x'.repeat(100),
  ]) {
    assert.equal(p(bad, NOW), null, `should reject ${JSON.stringify(bad)}`);
  }
  // sanity: the lenient parser would have accepted some of these
  assert.ok(!Number.isNaN(Date.parse('Nov 5 2026')));
  assert.equal(p('Nov 5 2026', NOW), null);
});

test('relative forms need a reference time', () => {
  assert.equal(p('3 hours ago'), null);
});

test('window check: exact times are inclusive, day-only counts when the UTC day overlaps', () => {
  const start = NOW - 24 * H;
  assert.equal(isInWindow(p('2026-11-05T11:00:00Z', NOW), start, NOW), true);
  assert.equal(isInWindow({ start, end: start, precision: 'time' }, start, NOW), true);
  assert.equal(isInWindow(p('2026-11-04T11:59:59Z', NOW), start, NOW), false);
  // window starts 2026-11-04 12:00Z, so the whole day 2026-11-04 overlaps it
  assert.equal(isInWindow(p('2026-11-04', NOW), start, NOW), true);
  assert.equal(isInWindow(p('2026-11-03', NOW), start, NOW), false);
  assert.equal(isInWindow(p('2026-11-06T00:00:00Z', NOW), start, NOW), false); // after the window end
});

test('relative forms in window', () => {
  const start = NOW - 24 * H;
  assert.equal(isInWindow(p('23 hours ago', NOW), start, NOW), true);
  assert.equal(isInWindow(p('1 day ago', NOW), start, NOW), false); // 24-48h ago
  assert.equal(isInWindow(p('2 days ago', NOW), start, NOW), false);
  assert.equal(isInWindow(p('2 days ago', NOW), NOW - 72 * H, NOW), true);
  assert.equal(isInWindow(null, start, NOW), false);
});

test('representativeTime stays at or before the window end', () => {
  const day = p('2026-11-05', NOW);
  assert.equal(representativeTime(day, NOW), NOW);
  assert.equal(representativeTime(p('2026-11-05T10:00:00Z', NOW), NOW), Date.UTC(2026, 10, 5, 10));
});
