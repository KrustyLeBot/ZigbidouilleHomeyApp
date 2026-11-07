'use strict';

const test = require('node:test');
const assert = require('node:assert');
const tz = require('../src/tz');
const plans = require('../src/plans');

const PARIS = 'Europe/Paris';

test('offsetMinutes follows Paris DST', () => {
  assert.strictEqual(tz.offsetMinutes(PARIS, Date.UTC(2026, 0, 15, 12)), 60);
  assert.strictEqual(tz.offsetMinutes(PARIS, Date.UTC(2026, 6, 15, 12)), 120);
  assert.strictEqual(tz.offsetMinutes('UTC', Date.UTC(2026, 6, 15, 12)), 0);
  assert.strictEqual(tz.offsetMinutes('America/New_York', Date.UTC(2026, 0, 15, 12)), -300);
});

test('nextTransitions finds the EU change instants', () => {
  // 2026: summer time starts 29 March 01:00 UTC, ends 25 October 01:00 UTC.
  const [next, second] = tz.nextTransitions(PARIS, Date.UTC(2026, 0, 1), 2);
  assert.deepStrictEqual(next, { offsetMinutes: 120, atMs: Date.UTC(2026, 2, 29, 1) });
  assert.deepStrictEqual(second, { offsetMinutes: 60, atMs: Date.UTC(2026, 9, 25, 1) });
});

test('validateMeals refuses what it cannot represent', () => {
  assert.throws(() => plans.validateMeals([{ time: '8:00', days: [1], portions: 1 }]), /HH:MM/);
  assert.throws(() => plans.validateMeals([{ time: '08:00', days: [], portions: 1 }]), /days/);
  assert.throws(() => plans.validateMeals([{ time: '08:00', days: [8], portions: 1 }]), /days/);
  assert.throws(() => plans.validateMeals([{ time: '08:00', days: [1], portions: 0 }]), /portions/);
  assert.deepStrictEqual(plans.validateMeals([{ time: '08:00', days: [3, 1, 1], portions: 2 }]),
    [{ time: '08:00', days: [1, 3], portions: 2, enabled: true }]);
});

test('toWire converts local time to UTC, moving days across midnight', () => {
  const meals = plans.validateMeals([
    { time: '08:00', days: [1, 2, 3, 4, 5, 6, 7], portions: 2 },
    { time: '00:30', days: [1], portions: 1 },
    { time: '19:00', days: [6, 7], portions: 3, enabled: false },
  ]);
  const summer = plans.toWire(meals, 120, { callSound: true, syncTime: 42 });
  assert.deepStrictEqual(summer, [
    { planId: 5000001, executionTime: '06:00', repeatDay: [1, 2, 3, 4, 5, 6, 7], enableAudio: true, audioTimes: 1, grainNum: 2, syncTime: 42 },
    // 00:30 Monday at UTC+2 is 22:30 Sunday UTC.
    { planId: 5000002, executionTime: '22:30', repeatDay: [7], enableAudio: true, audioTimes: 1, grainNum: 1, syncTime: 42 },
  ]);
  const negative = plans.toWire(plans.validateMeals([{ time: '23:00', days: [7], portions: 1 }]), -300, { syncTime: 1 });
  // 23:00 Sunday in New York winter is 04:00 Monday UTC.
  assert.strictEqual(negative[0].executionTime, '04:00');
  assert.deepStrictEqual(negative[0].repeatDay, [1]);
});

test('occurrences lists UTC firings and honours skipEndTime', () => {
  const wire = [{ planId: 1, executionTime: '06:00', repeatDay: [1, 2, 3, 4, 5, 6, 7], grainNum: 1 }];
  const from = Date.UTC(2026, 6, 13, 0); // Monday
  const occ = plans.occurrences(wire, from, from + 2 * tz.DAY_MS);
  assert.deepStrictEqual(occ.map((o) => o.at), [Date.UTC(2026, 6, 13, 6), Date.UTC(2026, 6, 14, 6)]);
  const skipped = plans.occurrences([{ ...wire[0], skipEndTime: Date.UTC(2026, 6, 13, 7) }], from, from + 2 * tz.DAY_MS);
  assert.deepStrictEqual(skipped.map((o) => o.at), [Date.UTC(2026, 6, 14, 6)]);
  const mondayOnly = plans.occurrences([{ ...wire[0], repeatDay: [1] }], from, from + 7 * tz.DAY_MS);
  assert.deepStrictEqual(mondayOnly.map((o) => o.at), [Date.UTC(2026, 6, 13, 6)]);
});

test('fall back: a meal already served is not served again at its new UTC time', () => {
  // A 02:30 local meal on 25 Oct 2026. Old list (UTC+2) fired it at 00:30 UTC;
  // after the change (01:00 UTC) the new list (UTC+1) would fire it at 01:30 UTC.
  const meals = plans.validateMeals([{ time: '02:30', days: [1, 2, 3, 4, 5, 6, 7], portions: 1 }]);
  const oldWire = plans.toWire(meals, 120, { syncTime: 1 });
  const newWire = plans.toWire(meals, 60, { syncTime: 2 });
  const now = Date.UTC(2026, 9, 25, 1, 0, 30);
  const withSkip = plans.addDstSkips(oldWire, newWire, now);
  assert.strictEqual(withSkip[0].skipEndTime, Date.UTC(2026, 9, 25, 1, 31));
  // And a meal far from the change is left alone.
  const breakfast = plans.validateMeals([{ time: '08:00', days: [1, 2, 3, 4, 5, 6, 7], portions: 1 }]);
  const untouched = plans.addDstSkips(plans.toWire(breakfast, 120), plans.toWire(breakfast, 60), now);
  assert.strictEqual(untouched[0].skipEndTime, undefined);
  // forWire drops an expired skip.
  assert.strictEqual(plans.forWire(withSkip, Date.UTC(2026, 9, 26))[0].skipEndTime, undefined);
});
