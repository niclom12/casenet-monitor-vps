import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inWindow, nextDelayMs, parseWindow } from './schedule.js';

const W = parseWindow('America/Chicago', '1-5', '0800-1700');

test('weekday court hours are fast, Central time, end exclusive', () => {
  assert.equal(inWindow(W, new Date('2026-10-29T13:00:00Z')), true); // Thu 08:00 CDT
  assert.equal(inWindow(W, new Date('2026-10-29T12:59:00Z')), false); // Thu 07:59 CDT
  assert.equal(inWindow(W, new Date('2026-10-29T21:59:00Z')), true); // Thu 16:59 CDT
  assert.equal(inWindow(W, new Date('2026-10-29T22:00:00Z')), false); // Thu 17:00 CDT
});

test('weekends are slow all day', () => {
  assert.equal(inWindow(W, new Date('2026-10-31T16:00:00Z')), false); // Sat 11:00 CDT
  assert.equal(inWindow(W, new Date('2026-11-01T16:00:00Z')), false); // Sun 10:00 CST
});

test('the window follows daylight saving', () => {
  // Mon 2 Nov 2026 is CST (UTC-6): 08:00 local is 14:00Z, not 13:00Z.
  assert.equal(inWindow(W, new Date('2026-11-02T13:30:00Z')), false);
  assert.equal(inWindow(W, new Date('2026-11-02T14:00:00Z')), true);
});

test('fast and slow intervals, and no backoff after failures', () => {
  const opts = { fastMs: 1_200_000, slowMs: 3_600_000, jitterPct: 0 };
  assert.equal(nextDelayMs({ ...opts, fast: true }), 1_200_000);
  assert.equal(nextDelayMs({ ...opts, fast: false }), 3_600_000);
});

test('jitter stays inside its band', () => {
  const opts = { fast: true, fastMs: 1_200_000, slowMs: 3_600_000, jitterPct: 25 };
  assert.equal(nextDelayMs({ ...opts, rand: () => 0 }), 900_000);
  assert.equal(nextDelayMs({ ...opts, rand: () => 1 }), 1_500_000);
});

test('a malformed window is refused', () => {
  assert.throws(() => parseWindow('America/Chicago', 'weekdays', '0800-1700'));
});
