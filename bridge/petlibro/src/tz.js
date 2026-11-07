'use strict';

// Timezone arithmetic with Intl only — no tz database to ship and keep fresh,
// Node's ICU already carries one.
//
// The feeder runs its plans in UTC and keeps no timezone of its own worth
// trusting, so every local <-> UTC decision is made here, against an IANA zone
// (the one Homey sends with the schedule, falling back to the container's TZ).
// `Date`'s local getters are deliberately never used: they read the zone the
// process runs in, which is exactly the trap the Homey side already fell into
// once (see CLAUDE.md, "Date's local getters are the Node process's timezone").

const DAY_MS = 86400000;
const formatters = new Map();
const transitionCache = new Map();
const TRANSITION_CACHE_MS = 6 * 3600 * 1000;

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    formatters.set(tz, f);
  }
  return f;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch (err) {
    return false;
  }
}

// Minutes east of UTC at that instant: +60 for Paris in winter, +120 in summer.
function offsetMinutes(tz, atMs = Date.now()) {
  const part = formatter(tz).formatToParts(new Date(atMs)).find((p) => p.type === 'timeZoneName');
  const m = /GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/.exec(part ? part.value : '');
  if (!m || !m[1]) return 0; // plain "GMT"
  const minutes = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === '-' ? -minutes : minutes;
}

// The next `count` offset changes after fromMs, as [{ offsetMinutes, atMs }].
// A day-by-day scan then a binary search inside the day that changed: cheap,
// and only redone every few hours since a found transition stays valid.
function nextTransitions(tz, fromMs = Date.now(), count = 2) {
  const cached = transitionCache.get(tz);
  if (cached && fromMs - cached.at < TRANSITION_CACHE_MS && cached.list.every((t) => t.atMs > fromMs)) {
    return cached.list.slice(0, count);
  }
  const list = [];
  let cur = fromMs;
  let curOffset = offsetMinutes(tz, cur);
  const end = fromMs + 730 * DAY_MS;
  while (list.length < count && cur < end) {
    const next = cur + DAY_MS;
    const nextOffset = offsetMinutes(tz, next);
    if (nextOffset !== curOffset) {
      let lo = cur;
      let hi = next;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetMinutes(tz, mid) === curOffset) lo = mid;
        else hi = mid;
      }
      list.push({ offsetMinutes: nextOffset, atMs: hi });
      curOffset = nextOffset;
    }
    cur = next;
  }
  transitionCache.set(tz, { at: fromMs, list });
  return list.slice(0, count);
}

// "YYYY-MM-DD HH:MM" in the given zone, for log lines a human will read.
function formatLocal(tz, atMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(atMs));
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

module.exports = { isValidTimezone, offsetMinutes, nextTransitions, formatLocal, DAY_MS };
