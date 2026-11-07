'use strict';

// Feeding plans: what Homey edits (local time) versus what the feeder runs (UTC).
//
// Confirmed on a One RFID, fw 3.0.72 (petlibro-local docs/feeding-plan-dst.md):
// executionTime is UTC on the wire, and the feeder does NOT move its plans when
// the time sync announces a DST change. So the meals are stored here in LOCAL
// time — the user's intent, "08:00 every day" — and the UTC list is derived
// from them with the offset of the moment it is sent. When the offset changes,
// the bridge re-derives and re-sends; nobody has to remember to.
//
// repeatDay is 1 = Monday ... 7 = Sunday, on both sides.

const { DAY_MS } = require('./tz');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Six, like the meal slots in the Homey device settings: a schedule saved from
// the web page must still fit what Homey can show and edit.
const MAX_MEALS = 6;
const MAX_PORTIONS = 10;
// planIds the Petlibro app itself does not use (it picks random 5,000,000+
// values too, per petlibro-local's editor) — stable per slot so an ack can be
// matched back to the meal that produced it.
const PLAN_ID_BASE = 5000000;

function toMinutes(hhmm) {
  const m = TIME_RE.exec(hhmm);
  return Number(m[1]) * 60 + Number(m[2]);
}

function toHhmm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function shiftDay(day, delta) {
  return ((day - 1 + delta + 7) % 7) + 1;
}

// Throws on anything malformed rather than "fixing" it: a schedule that feeds
// animals must say exactly what was asked, or be refused loudly.
function validateMeals(meals) {
  if (!Array.isArray(meals)) throw new Error('meals must be an array');
  if (meals.length > MAX_MEALS) throw new Error(`at most ${MAX_MEALS} meals`);
  return meals.map((meal, i) => {
    if (!meal || typeof meal !== 'object') throw new Error(`meal ${i + 1}: not an object`);
    if (!TIME_RE.test(meal.time || '')) throw new Error(`meal ${i + 1}: time must be HH:MM`);
    const days = Array.isArray(meal.days) ? [...new Set(meal.days.map(Number))].sort((a, b) => a - b) : [];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error(`meal ${i + 1}: days must be a non-empty list of 1 (Mon) .. 7 (Sun)`);
    }
    const portions = Number(meal.portions);
    if (!Number.isInteger(portions) || portions < 1 || portions > MAX_PORTIONS) {
      throw new Error(`meal ${i + 1}: portions must be 1..${MAX_PORTIONS}`);
    }
    return { time: meal.time, days, portions, enabled: meal.enabled !== false };
  });
}

// Local meals -> the feeder's UTC plans, at a given UTC offset (minutes east).
// A meal that crosses midnight in the conversion moves its days with it:
// 00:30 Monday in Paris summer time is 22:30 SUNDAY in UTC.
function toWire(meals, offsetMinutes, { callSound = true, syncTime = Date.now() } = {}) {
  const plans = [];
  meals.forEach((meal, i) => {
    if (!meal.enabled) return;
    let minutes = toMinutes(meal.time) - offsetMinutes;
    let dayDelta = 0;
    if (minutes < 0) {
      minutes += 1440;
      dayDelta = -1;
    } else if (minutes >= 1440) {
      minutes -= 1440;
      dayDelta = 1;
    }
    plans.push({
      planId: PLAN_ID_BASE + i + 1,
      executionTime: toHhmm(minutes),
      repeatDay: meal.days.map((d) => shiftDay(d, dayDelta)).sort((a, b) => a - b),
      enableAudio: Boolean(callSound),
      audioTimes: 1,
      grainNum: meal.portions,
      syncTime,
    });
  });
  plans.sort((a, b) => a.executionTime.localeCompare(b.executionTime));
  return plans;
}

function utcWeekday(ms) {
  const d = new Date(ms).getUTCDay();
  return d === 0 ? 7 : d;
}

// Every time a UTC plan list fires within (fromMs, toMs], as [{ planId, at }].
// Honours skipEndTime the way the feeder does: an occurrence before it is skipped.
function occurrences(plans, fromMs, toMs) {
  const out = [];
  if (!(toMs > fromMs)) return out;
  const firstDay = Math.floor(fromMs / DAY_MS) - 1;
  const lastDay = Math.floor(toMs / DAY_MS) + 1;
  for (const plan of plans) {
    const minutes = toMinutes(plan.executionTime);
    for (let day = firstDay; day <= lastDay; day += 1) {
      const at = day * DAY_MS + minutes * 60000;
      if (at <= fromMs || at > toMs) continue;
      if (!plan.repeatDay.includes(utcWeekday(at))) continue;
      if (typeof plan.skipEndTime === 'number' && at < plan.skipEndTime) continue;
      out.push({ planId: plan.planId, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// After a DST change the same local meal gets a new UTC time. When clocks fall
// back, that new time is LATER: a meal the feeder already served under the old
// list would be served again under the new one. Any meal whose old occurrence
// is recent and whose new one is still ahead gets a one-off skip up to just
// past that new occurrence. Errs towards skipping, like petlibro-local does —
// one late meal is better than a double portion for a cat on a diet.
// Spring forward is the opposite case (a meal can be missed, never repeated)
// and needs nothing here.
const DST_WINDOW_MS = 2 * 3600 * 1000;
const RUN_MARGIN_MS = 2 * 60000;

function addDstSkips(oldPlans, newPlans, nowMs) {
  const recentOld = occurrences(oldPlans, nowMs - DST_WINDOW_MS, nowMs + RUN_MARGIN_MS);
  return newPlans.map((plan) => {
    if (!recentOld.some((o) => o.planId === plan.planId)) return plan;
    const upcoming = occurrences([plan], nowMs, nowMs + DST_WINDOW_MS);
    if (!upcoming.length) return plan;
    return { ...plan, skipEndTime: upcoming[0].at + 60000 };
  });
}

// What actually goes on the wire: a skipEndTime already in the past is dropped,
// it has done its job and would only confuse the next reader of a capture.
function forWire(plans, nowMs) {
  return plans.map((plan) => {
    if (typeof plan.skipEndTime === 'number' && plan.skipEndTime <= nowMs) {
      const { skipEndTime, ...rest } = plan;
      return rest;
    }
    return plan;
  });
}

module.exports = {
  validateMeals,
  toWire,
  occurrences,
  addDstSkips,
  forWire,
  toMinutes,
  MAX_MEALS,
  MAX_PORTIONS,
};
