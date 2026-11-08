'use strict';

// Refill reminder: "it has been N days since the hopper was filled".
//
// A calendar backstop for the hopper sensor, the same idea as petlibro-local's
// food_refill_due. Needed here because on both of our units the sensor never
// reported an empty hopper (surplusGrain stayed true through a run of feeds
// that dispensed nothing — see docs/fingerprints.md).
//
// Days are counted in the feeder's local calendar (the IANA zone Homey sends),
// and the reminder fires at a local time of day, then again every day at that
// time until the hopper is marked as refilled.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86400000;
const DEFAULTS = { enabled: true, intervalDays: 14, time: '09:00' };

function localParts(tz, ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => Number((parts.find((p) => p.type === type) || {}).value);
  return { y: get('year'), m: get('month'), d: get('day'), minutes: get('hour') * 60 + get('minute') };
}

// A local calendar date as a plain day count, so date differences ignore DST.
function dayNumber(p) {
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS);
}

function dayToIso(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function validate({ enabled, intervalDays, time } = {}) {
  const out = {};
  if (enabled !== undefined) out.enabled = Boolean(enabled);
  if (intervalDays !== undefined) {
    const n = Number(intervalDays);
    if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error('intervalDays must be 1..90');
    out.intervalDays = n;
  }
  if (time !== undefined) {
    if (!TIME_RE.test(String(time))) throw new Error('time must be HH:MM');
    out.time = String(time);
  }
  return out;
}

// What the reminder says right now. `remind` is true once per local day, at or
// after the configured time, while the hopper is due.
function status(cfg, tz, now) {
  const c = { ...DEFAULTS, ...cfg };
  const last = localParts(tz, c.lastRefill);
  const today = localParts(tz, now);
  const lastDay = dayNumber(last);
  const todayNum = dayNumber(today);
  const [h, m] = c.time.split(':').map(Number);
  const timeReached = today.minutes >= h * 60 + m;
  const days = todayNum - lastDay;
  const dueDay = lastDay + c.intervalDays;
  const due = c.enabled && (todayNum > dueDay || (todayNum === dueDay && timeReached));
  return {
    enabled: c.enabled,
    intervalDays: c.intervalDays,
    time: c.time,
    lastRefill: c.lastRefill,
    daysSinceRefill: days,
    nextReminder: c.enabled ? `${dayToIso(Math.max(dueDay, todayNum + (due && timeReached ? 1 : 0)))} ${c.time}` : null,
    due,
    remind: due && timeReached && c.lastReminderDay !== todayNum,
    todayNum,
  };
}

module.exports = { status, validate, DEFAULTS };
