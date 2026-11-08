'use strict';

const test = require('node:test');
const assert = require('node:assert');
const refill = require('../src/refill');

const PARIS = 'Europe/Paris';
// 1 Nov 2026 is winter time in Paris (UTC+1): 09:00 local = 08:00 UTC.
const filled = Date.UTC(2026, 10, 1, 18, 0); // Sunday 1 Nov, 19:00 local
const cfg = { enabled: true, intervalDays: 14, time: '09:00', lastRefill: filled };

test('not due before the interval, due at the local time of the last day', () => {
  assert.strictEqual(refill.status(cfg, PARIS, Date.UTC(2026, 10, 14, 12)).due, false);
  const before = refill.status(cfg, PARIS, Date.UTC(2026, 10, 15, 7, 59)); // 08:59 local
  assert.strictEqual(before.due, false);
  assert.strictEqual(before.nextReminder, '2026-11-15 09:00');
  const at = refill.status(cfg, PARIS, Date.UTC(2026, 10, 15, 8, 0)); // 09:00 local
  assert.strictEqual(at.due, true);
  assert.strictEqual(at.remind, true);
  assert.strictEqual(at.daysSinceRefill, 14);
});

test('reminds once per day, every day, until refilled', () => {
  const day15 = refill.status(cfg, PARIS, Date.UTC(2026, 10, 15, 8, 30));
  const reminded = { ...cfg, lastReminderDay: day15.todayNum };
  assert.strictEqual(refill.status(reminded, PARIS, Date.UTC(2026, 10, 15, 20)).remind, false);
  // Next day: still due, but not before 09:00 local.
  assert.strictEqual(refill.status(reminded, PARIS, Date.UTC(2026, 10, 16, 7)).remind, false);
  assert.strictEqual(refill.status(reminded, PARIS, Date.UTC(2026, 10, 16, 8, 5)).remind, true);
});

test('disabled never reminds; validate refuses nonsense', () => {
  assert.strictEqual(refill.status({ ...cfg, enabled: false }, PARIS, Date.UTC(2027, 0, 1, 12)).remind, false);
  assert.throws(() => refill.validate({ intervalDays: 0 }), /1\.\.90/);
  assert.throws(() => refill.validate({ time: '9h' }), /HH:MM/);
  assert.deepStrictEqual(refill.validate({ enabled: false, intervalDays: '7', time: '18:30' }), { enabled: false, intervalDays: 7, time: '18:30' });
});
