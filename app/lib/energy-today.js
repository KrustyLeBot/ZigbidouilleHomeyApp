'use strict';

// Imported energy since local midnight, for one metered device — the whole
// content of the dashboard widget.
//
// This replaces a per-minute recorder that fed a 24 h chart. The chart is gone:
// what was actually wanted is one number, today's kWh, and keeping 1440 samples
// per device in the device store to draw it was the tail wagging the dog.
//
// The figure is a DELTA against the meter's own cumulative counter, never a sum
// this class accumulates: an accumulator drifts, and it restarts from zero every
// time the app is reinstalled. So all that has to be remembered is the meter
// reading as it stood at 00:00, and there are three ways to get it, in order of
// preference:
//
//  1. The value persisted in the device store, if it is from today — survives an
//     app restart and a CLI reinstall, which is the common case.
//  2. Homey's Insights, through the Web API — the only way to learn the 00:00
//     reading for a day that is already underway (a fresh pair, or a store that
//     was wiped). This is what stops the widget from reading 0.00 for the rest
//     of the day after a mid-afternoon reinstall.
//  3. The meter as it stands right now — wrong, but wrong in the obvious
//     direction: today's figure reads 0 and climbs.
//
// The app's own `homey.insights` is NOT the way in: its `getLog(id)` only
// returns logs the app itself created, and a device capability's log belongs to
// Homey core. Hence HomeyAPI, and hence the `homey:manager:api` permission.

const { HomeyAPI } = require('homey-api');
const { deviceUuid } = require('./device-uuid');
const errlog = require('./errlog');

// Only to notice local midnight and to anchor the baseline on the first run of
// a day; the displayed figure is computed on read, not sampled.
const SAMPLE_INTERVAL = 60 * 1000;
const RETRY_INTERVAL = 10 * 60 * 1000;
const STORE_KEY = 'energy_today';
// Bumped whenever the meaning of a stored field changes; restore() refuses
// anything older. See restore() for why this is not merely hygiene.
//
// Bumped 2 -> 3 for the UTC/local dayKey() fix: a baseline anchored earlier
// today by the old process-timezone logic would otherwise sit unchanged until
// the next real local midnight (restore() never re-derives a same-day
// baseline), so the fix would not visibly do anything until the day after it
// shipped. This forces one fresh Insights-based rebase per channel instead.
const STORE_VERSION = 3;

// EVERY step that talks to the network gets a deadline. Not defensive padding:
// the first version of this logged neither success nor failure, which only one
// thing explains — a promise that never settled. `getOwnerApiToken()`, the local
// URL lookup and the Insights requests have no timeout of their own, and a hung
// one is indistinguishable from a feature that was never wired up.
const STEP_TIMEOUT = 20 * 1000;

function withTimeout(promise, label, ms = STEP_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Local date, deliberately: "today" for the user is their midnight, not the
// app process's. Date.prototype.getFullYear()/getMonth()/getDate() do NOT give
// that — they use the Node process's OS timezone, which on Homey is commonly
// UTC regardless of the timezone configured in Homey's own settings. That
// mismatch is exactly why the SDK ships homey.clock.getTimezone() (see
// athombv/homey-apps-sdk-issues#169) — this widget used to skip it and roll
// the day over at UTC midnight instead of the user's, which reads as a wrong
// kWh figure for up to a few hours around every real midnight, worse the
// further the user's zone sits from UTC.
function dayKey(homey, date = new Date()) {
  const timeZone = homey && homey.clock && typeof homey.clock.getTimezone === 'function'
    ? homey.clock.getTimezone()
    : undefined; // no homey instance (e.g. a unit test) — falls back to process-local
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

// One HomeyAPI instance for the whole app: each channel would otherwise open
// its own, and building one costs a token fetch plus a local URL lookup.
let apiPromise = null;

function getApi(homey) {
  if (!apiPromise) {
    apiPromise = withTimeout(HomeyAPI.createAppAPI({ homey }), 'createAppAPI').catch((err) => {
      apiPromise = null; // let a later device retry rather than cache a failure
      throw err;
    });
  }
  return apiPromise;
}

// Homey has changed how it names Insights periods before, and the valid set is
// not in the local API spec — so ask for the day, and fall back to a fixed 24 h
// window. Entries are filtered to today below either way, so a wider window is
// harmless.
const RESOLUTIONS = ['today', 'last24Hours'];

// Resolve the log id, never assume it — the SPEC AND THE FIRMWARE DISAGREE.
//
// The shipped spec (homey-api/assets/specifications/HomeyAPIV3Local.json,
// ManagerInsights) says a Log's `id` is a plain UUID with the device in
// `ownerUri`. Read on a real Homey Pro (firmware 12.x), the ids are in fact
// `homey:device:<uuid>:<capability>`, with `ownerId` holding the bare capability
// id. Hence getLogs() and a ranked match instead of either assumption, and hence
// reportLogs(): the log line below is the only reliable statement of what this
// firmware actually returns.
//
// What did kill the first attempt was NOT the id shape — it was asking for a
// capability with no log at all. A Shelly channel has `energy_power` (W),
// `meter_power` and `meter_power.exported` (kWh); `measure_power` is not among
// them, so `homey:device:<uuid>:measure_power` 404s no matter how it is built.
// "Not Found" therefore means "no such log", which is not the same as "wrong id
// format" — and reading it as the latter cost a whole detour.
let reportedLogs = false;

// At INFO only when the match found NOTHING — that is the case where this listing
// is the evidence, and printing it on every successful rebase was a 400-character
// line saying "as expected". Verbose still gets it either way.
function reportLogs(logs, uuid, matched) {
  if (reportedLogs) return;
  reportedLogs = true;
  const mine = logs
    .filter((log) => log && typeof log.ownerUri === 'string' && log.ownerUri.includes(uuid))
    .map((log) => `${log.id} ownerId=${log.ownerId} title=${log.title} units=${log.units}`);
  const message = mine.length
    ? `logs for device ${uuid}: ${mine.join(' | ')}`
    : `no Insights log has ownerUri containing ${uuid} (of ${logs.length} logs)`;
  if (matched) errlog.debug('insights', message);
  else errlog.info('insights', message);
}

// The unit each capability's log carries, for the fallback below.
const UNITS = { meter_power: 'kwh', measure_power: 'w' };

// Titles of the OTHER kWh log a metered channel has: the exported register.
// Homey titles it in the user's language, hence several spellings.
const EXPORT_HINTS = ['export', 'inject', 'produ', 'retour'];

// Returns log ids to try, best guess first.
async function resolveLogIds(api, uuid, capabilityId) {
  const result = await withTimeout(api.insights.getLogs(), 'insights.getLogs');
  const logs = Array.isArray(result) ? result : Object.values(result || {});

  const composed = `homey:device:${uuid}:${capabilityId}`;
  const mine = logs.filter((log) => log
    && typeof log.ownerUri === 'string' && log.ownerUri.includes(uuid));

  // 1. Something on the log names the capability outright.
  const named = mine.filter((log) => log.ownerId === capabilityId
    || log.ownerId === composed
    || log.ownerId === `${uuid}:${capabilityId}`
    || log.id === capabilityId
    || log.id === composed);

  // 2. Nothing does — so go by the unit. A metering channel has exactly two kWh
  //    logs (imported and exported) and one W log, so the unit plus "not the
  //    exported one" is enough to single it out. Weaker than a name match, which
  //    is why it comes second, but it beats giving up: without it a firmware that
  //    keeps the capability id nowhere on the log leaves the widget stuck at
  //    "since install" forever.
  const wanted = UNITS[capabilityId];
  const byUnit = mine.filter((log) => {
    if (named.includes(log)) return false;
    if (!wanted || String(log.units || '').toLowerCase() !== wanted) return false;
    const title = String(log.title || '').toLowerCase();
    return !EXPORT_HINTS.some((hint) => title.includes(hint));
  });

  const ids = [...named, ...byUnit].map((log) => log.id).filter(Boolean);
  reportLogs(logs, uuid, ids.length > 0);
  return ids;
}

async function fetchEntries(api, uuid, capabilityId) {
  const candidates = [];

  try {
    candidates.push(...await resolveLogIds(api, uuid, capabilityId));
  } catch (err) {
    // getLogs() itself failed (permission, firmware, timeout) — the composed id
    // below is still worth a try, and the error surfaces if that fails too.
  }
  candidates.push(`homey:device:${uuid}:${capabilityId}`);

  let lastError = null;
  let answered = false; // at least one candidate existed, even if it was empty

  for (const id of candidates) {
    for (const resolution of RESOLUTIONS) {
      try {
        const result = await withTimeout(
          api.insights.getLogEntries({ id, resolution }),
          `getLogEntries ${resolution}`,
        );
        // The response shape is not in the spec: accept a bare array as well as
        // the { values: [...] } envelope.
        const entries = Array.isArray(result)
          ? result
          : ((result && Array.isArray(result.values)) ? result.values : []);

        answered = true;
        // An empty answer does NOT end the search: it is exactly what a log that
        // exists but is the wrong one returns, and stopping there would pick it
        // over a later candidate that actually holds today.
        if (entries.length) {
          errlog.debug('insights', `${capabilityId}: ${entries.length} entries from log ${id}`);
          return entries;
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  if (answered) return [];
  throw lastError || new Error('no Insights entries');
}

// `t` comes back as an ISO string on some firmwares and epoch ms on others.
function entryTime(entry) {
  const t = entry && entry.t !== undefined ? entry.t : (entry && entry.date);
  if (typeof t === 'number') return new Date(t);
  if (typeof t === 'string') {
    const parsed = new Date(t);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

class EnergyToday {
  constructor(device) {
    this.device = device;
    this.day = null;
    this.baselineKwh = null;
    // True while the baseline is a guess made mid-day (case 3 above) rather than
    // a real 00:00 reading. Only then is Insights worth asking, and only then may
    // its answer overwrite what is already here.
    this.baselineIsGuess = false;
    this.timer = null;
    this.rebasing = false;
    this.lastRebaseAttempt = null;
  }

  async start() {
    await this.restore();
    this.sample();

    // Deliberately not awaited: this talks to the Web API, and onNodeInit must
    // not wait on it — this device's init is already the fragile part of
    // pairing. Failures are logged at INFO, never debug: a failed rebase is
    // invisible in the widget (it just shows a smaller number) and used to be
    // invisible in the log too, which is how a broken Insights log id survived
    // unnoticed.
    if (this.baselineIsGuess) this.retryRebase();

    this.timer = this.device.homey.setInterval(() => this.sample(), SAMPLE_INTERVAL);
  }

  stop() {
    if (this.timer) this.device.homey.clearInterval(this.timer);
    this.timer = null;
  }

  async restore() {
    let stored = null;
    try {
      stored = this.device.getStoreValue(STORE_KEY);
    } catch (err) {
      // A missing/corrupt store is not worth failing init over: the baseline is
      // simply re-anchored below.
    }

    if (!stored || stored.day !== dayKey(this.device.homey)) return; // yesterday's baseline, drop it
    if (typeof stored.baselineKwh !== 'number') return;

    // A record written by an older build is dropped rather than trusted. This is
    // not future-proofing: the build before this one saved a mid-day baseline
    // with `baselineIsGuess: false`, and a same-day record is by design NOT
    // re-derived — so that one wrong number would have survived every reinstall
    // until midnight, looking exactly like the bug it came from. Anything that
    // changes what a stored field MEANS has to bump this.
    if (stored.v !== STORE_VERSION) {
      errlog.info(`${this.device.getName()}: baseline dropped`,
        `stored by an older format (v=${stored.v}) — re-deriving from Insights`);
      return;
    }

    this.day = stored.day;
    this.baselineKwh = stored.baselineKwh;
    this.baselineIsGuess = Boolean(stored.baselineIsGuess);
  }

  readMeter() {
    const value = this.device.getCapabilityValue('meter_power');
    return typeof value === 'number' ? value : null;
  }

  sample() {
    const today = dayKey(this.device.homey);

    // A COLD START (`day === null`: nothing usable in the store) and CROSSING
    // MIDNIGHT while running both leave `day !== today`, and they are not the
    // same thing at all:
    //
    //  - crossing midnight — the meter right now IS the 00:00 reading. Certain.
    //  - cold start — the meter right now is wherever the day has got to. A
    //    guess, and the only case Insights can fix.
    //
    // Collapsing the two is what made this widget read ~0 after a reinstall: the
    // baseline was marked certain, so the Insights rebase was skipped and never
    // logged a thing. The old day being non-null is the whole distinction.
    if (this.day === null) {
      this.day = today;
      this.baselineKwh = this.readMeter();
      this.baselineIsGuess = true;
      this.persist();
      return;
    }

    if (this.day !== today) {
      this.day = today;
      this.baselineKwh = this.readMeter();
      this.baselineIsGuess = false;
      this.persist();
      return;
    }

    // Restored a baseline of the right day, but the meter had not been read yet
    // when it was written.
    if (this.baselineKwh === null) {
      this.baselineKwh = this.readMeter();
      this.baselineIsGuess = this.baselineKwh !== null;
      this.persist();
      return;
    }

    // Still working off a guess: try Insights again. One attempt at boot is not
    // enough — the meter may not have reported yet when it ran, or the request
    // may have timed out, and either way a wrong figure would then stand for the
    // rest of the day.
    if (this.baselineIsGuess) this.retryRebase();
  }

  // Rate-limited retry, driven by the same one-minute tick as sample(). Bounded
  // by baselineIsGuess going false, so a Homey whose Insights genuinely holds
  // nothing for today retries every 10 minutes and no more.
  retryRebase() {
    if (this.rebasing) return;
    const now = Date.now();
    if (this.lastRebaseAttempt && now - this.lastRebaseAttempt < RETRY_INTERVAL) return;

    this.lastRebaseAttempt = now;
    this.rebasing = true;
    this.rebaseFromInsights()
      .catch((err) => errlog.info(`${this.device.getName()}: rebase failed`, err.message))
      .then(() => { this.rebasing = false; });
  }

  persist() {
    // Written on change only, not every minute: there is nothing here that
    // moves between midnights.
    this.device.setStoreValue(STORE_KEY, {
      v: STORE_VERSION,
      day: this.day,
      baselineKwh: this.baselineKwh,
      baselineIsGuess: this.baselineIsGuess,
    }).catch(() => {
      // Best-effort: losing the persisted copy costs an accurate figure after
      // the next restart, never the running widget.
    });
  }

  // Replaces a guessed baseline with the meter reading Insights holds for the
  // start of today. This is the entire reason the widget can be installed at
  // 16:00 and still report the day.
  async rebaseFromInsights() {
    if (!this.baselineIsGuess) return; // the baseline is a real midnight reading

    const uuid = deviceUuid(this.device);
    // Logged rather than returned silently: no uuid means device-uuid.js failed
    // to discover Homey's id on the instance, which is a real failure and not
    // "nothing to do".
    if (!uuid) {
      errlog.info(`${this.device.getName()}: rebase skipped`, 'no Homey device uuid found');
      return;
    }

    // Verbose-only now. This existed because a hung request produced no line at
    // all, making "never ran" and "still waiting" indistinguishable — withTimeout
    // above closed that hole, so a hang reports itself as a failure.
    errlog.debug(`${this.device.getName()}: rebase`, `asking Insights for ${uuid}`);

    const api = await getApi(this.device.homey);
    const today = dayKey(this.device.homey);

    const entries = await fetchEntries(api, uuid, 'meter_power');
    const todays = entries.filter((entry) => {
      const date = entryTime(entry);
      return date && dayKey(this.device.homey, date) === today && typeof entry.v === 'number';
    });

    const first = todays.length ? todays[0].v : null;
    const meter = this.readMeter();

    // Sanity: the day's first reading cannot be meaningfully above the meter's
    // current total, since the counter only climbs. A value well over it is a log
    // for another device or another unit, and using it would show a negative day.
    //
    // The tolerance is not slack — Insights ROUNDS: a channel sitting at
    // 0.048647 kWh all day comes back as 0.05, which is genuinely above the
    // meter. Compared strictly, that channel is rejected every ten minutes
    // forever and stays labelled "since install" for a day in which it used
    // nothing. Observed on "Dalle chauffante", 9 entries found and all refused.
    const TOLERANCE_KWH = 0.05;
    const usable = first !== null && (meter === null || first <= meter + TOLERANCE_KWH);

    if (usable) {
      // Clamped, so the rounding that made the tolerance necessary can never
      // produce a negative figure either.
      this.baselineKwh = meter === null ? first : Math.min(first, meter);
      this.baselineIsGuess = false;
      this.persist();
    }

    errlog.info(
      `${this.device.getName()}: rebase`,
      `${entries.length} Insights entries, ${todays.length} today, `
      + `first=${first}, meter=${meter}, `
      + `baseline=${usable ? this.baselineKwh : 'unchanged (rejected)'}`,
    );
  }

  // Shape consumed by the widget.
  toJSON() {
    const meter = this.readMeter();
    const kwh = (meter !== null && this.baselineKwh !== null)
      ? Math.max(0, meter - this.baselineKwh)
      : null;

    return {
      day: this.day,
      kwh,
      // The widget says so when the figure only covers part of the day, rather
      // than presenting a partial total as if it were the day's.
      partial: this.baselineIsGuess,
    };
  }
}

module.exports = EnergyToday;
