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
//
// Bumped 3 -> 4 for the frozen-meter-at-midnight fix (see the `live` check in
// sample()): a baseline captured while meter_power was frozen from an earlier
// failed boot got marked "certain" and never revisited, overreporting the
// whole day by the missed amount. Same reasoning as the 2->3 bump — a same-day
// record is never re-derived on its own, so this is what makes today's figure
// correct today instead of tomorrow.
//
// Bumped 4 -> 5 for the rebaseFromInsights() ordering fix: `todays[0]` assumed
// getLogEntries() returns entries oldest-first, and a live response proved
// that assumption wrong — entries[0] was NOT the earliest of the day, so the
// 4->5 rebase itself picked a bad (much too old) baseline and marked it
// certain. Forces one more re-derivation, this time picking the actual
// earliest entry by timestamp.
const STORE_VERSION = 7;

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
  // At INFO unconditionally: a match is NOT evidence the right log was picked.
  // Reading another channel's kWh log satisfies every check here (right unit,
  // plausible value, below the meter) and yields a silently wrong figure — so
  // the listing has to be visible even, especially, on the success path.
  errlog.info('insights', `${message} — matched=${matched}`);
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
  // The composed id goes FIRST. It names this device and this capability
  // exactly, so when it resolves there is nothing to rank — whereas
  // resolveLogIds' unit-based fallback can legitimately return a SIBLING
  // channel's kWh log (same node, same unit, plausible value), which then
  // passes every downstream check and produces a confidently wrong figure.
  // Trying the exact id last meant the fuzzy answer won whenever it existed.
  const candidates = [`homey:device:${uuid}:${capabilityId}`];

  try {
    candidates.push(...await resolveLogIds(api, uuid, capabilityId));
  } catch (err) {
    // getLogs() itself failed (permission, firmware, timeout) — the composed id
    // above is still worth a try, and the error surfaces if that fails too.
  }

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
          // The id travels with the data: WHICH log answered is the thing that
          // separates a right figure from a plausible wrong one, and it used to
          // be dropped here.
          entries.logId = id;
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
    // True while the baseline has never been confirmed against the log — a
    // mid-day guess (case 3 above), or a midnight reading taken while the meter
    // was frozen. It no longer gates whether Insights is consulted (that now
    // happens on a fixed cadence), only what the widget labels as partial.
    this.baselineIsGuess = false;
    this.timer = null;
    this.rebasing = false;
    this.lastRebaseAttempt = null;
  }

  async start() {
    await this.restore();

    // The restored triple (day/baselineKwh/baselineIsGuess), before sample()
    // gets a chance to change all three in the same tick. Verbose: the first
    // rebase of every app run reports the outcome at INFO, and a rebase failure
    // does too, so this is only needed when the persistence itself is suspect.
    errlog.debug(
      `${this.device.getName()}: restore`,
      `day=${this.day} baselineKwh=${this.baselineKwh} guess=${this.baselineIsGuess} `
      + `meterNow=${this.readMeter()} today=${dayKey(this.device.homey)}`,
    );

    this.sample();

    // Deliberately not awaited: this talks to the Web API, and onNodeInit must
    // not wait on it — this device's init is already the fragile part of
    // pairing. Failures are logged at INFO, never debug: a failed rebase is
    // invisible in the widget (it just shows a smaller number) and used to be
    // invisible in the log too, which is how a broken Insights log id survived
    // unnoticed.
    this.retryRebase();

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

      // "Certain" only holds if the meter is actually LIVE right now. A device
      // that skipped re-registering its report listener this session (this
      // Shelly does, when a boot-time attribute read fails — see
      // registerEnergyChannel) has a capability value frozen at whatever it
      // was when reporting stopped, not the true reading at this instant. If
      // midnight falls inside such a session, trusting that frozen number as
      // the day's baseline understates it — every kWh missed since the freeze
      // then gets counted as "today", overreporting the whole day (proven:
      // a freeze from 17:46 to 00:01 the next boot, baseline off by ~9.7 kWh
      // until fixed here). A device with no isMeterLive() (e.g. the virtual
      // kwh-meter) is assumed live — it never freezes this way.
      const live = typeof this.device.isMeterLive !== 'function' || this.device.isMeterLive();
      this.baselineIsGuess = !live;
      if (!live) {
        errlog.info(`${this.device.getName()}: day boundary`,
          'meter not live this session — baseline flagged for Insights correction');
      }
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

    // Re-derive from the log on every tick (rate-limited to RETRY_INTERVAL
    // inside retryRebase). Not just while the baseline is a guess: a baseline
    // that was right an hour ago stops being right the moment the meter freezes
    // and catches up, and that is a routine event on this device.
    this.retryRebase();
  }

  // Rate-limited, driven by the same one-minute tick as sample(). No longer
  // bounded by baselineIsGuess: this is the day's figure being re-derived from
  // the log, so it runs every 10 minutes for as long as the app does.
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
    // Deliberately NOT guarded on baselineIsGuess anymore. It used to run once
    // and stop, on the assumption that a settled baseline stays correct for the
    // rest of the day — which holds only if the meter behaves for the rest of
    // the day. This one does not: a scale-read failure at any boot freezes
    // meter_power, and the catch-up step on the next boot inflates the figure
    // exactly as it did across midnight. Now that the computation derives the
    // whole day from the log rather than adjusting prior state, re-running it
    // is idempotent, so it simply runs on the same 10-minute cadence all day
    // and any artefact is corrected within one interval.
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
    // Keep the parsed Date alongside each entry — needed below to find the
    // actual earliest one, not just filter.
    const todays = entries
      .map((entry) => ({ entry, date: entryTime(entry) }))
      .filter(({ entry, date }) => date && dayKey(this.device.homey, date) === today
        && typeof entry.v === 'number');

    // The EARLIEST entry by timestamp, not entries[0]. getLogEntries' order is
    // undocumented and was assumed ascending — wrongly: a real response handed
    // back entries out of order, entries[0] landed on a value from BEFORE
    // yesterday evening, and that got accepted as "today's start" because nothing
    // here ever checked its timestamp, only its position. Reducing by date is
    // correct regardless of what order the API happens to return.
    let first = null;
    let firstAt = null;
    for (const { entry, date } of todays) {
      if (firstAt === null || date.getTime() < firstAt.getTime()) {
        first = entry.v;
        firstAt = date;
      }
    }
    const meter = this.readMeter();
    const sorted = todays.slice().sort((a, b) => a.date.getTime() - b.date.getTime());

    // Today's energy is the SUM OF PLAUSIBLE INCREMENTS, not last-minus-first.
    //
    // Those two are identical on a healthy day and differ exactly when the log
    // contains a discontinuity — which this device produces routinely. When a
    // boot fails to read the metering scale, meter_power stops being updated
    // (see registerEnergyChannel) and Insights records the same stale value for
    // hours; the next successful boot writes the true counter in one step, and
    // that step carries ALL the consumption of the frozen window. If the freeze
    // spans local midnight, last-minus-first credits the whole of yesterday
    // evening to today: observed here as 49.8 kWh on a day whose own log shows
    // a steady ~1 kW draw, i.e. ~20 kWh of real use plus a ~29 kWh step at
    // 00:01.
    //
    // Summing increments and dropping the impossible ones removes the step
    // without needing to know why it happened. The cap is deliberately far
    // above any real domestic load (the largest French domestic supply is
    // 36 kVA) so it can only ever reject an artefact: a genuine 5-minute step
    // at 30 kW would be 2.5 kWh, an order of magnitude past anything this
    // house draws, while the artefact was ~350 kW-equivalent.
    const MAX_PLAUSIBLE_KW = 30;
    let consumed = 0;
    let steps = 0; // increments rejected as physically impossible
    let drops = 0; // decreases: a counter reset, never real consumption

    for (let i = 1; i < sorted.length; i++) {
      const hours = (sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / 3600000;
      const delta = sorted[i].entry.v - sorted[i - 1].entry.v;

      if (delta < 0) { drops++; continue; }
      if (hours > 0 && delta > MAX_PLAUSIBLE_KW * hours) { steps++; continue; }
      consumed += delta;
    }

    // The gap between the last logged sample (up to 5 minutes old) and the live
    // meter. Same plausibility rule, so an unfreeze landing in this window
    // cannot sneak in either.
    const last = sorted.length ? sorted[sorted.length - 1] : null;
    if (last && meter !== null) {
      const hours = Math.max((Date.now() - last.date.getTime()) / 3600000, 1 / 60);
      const delta = meter - last.entry.v;
      if (delta > 0 && delta <= MAX_PLAUSIBLE_KW * hours) consumed += delta;
    }

    // Everything downstream still works off `baselineKwh`, so the result is
    // expressed as the baseline that WOULD have produced it. That keeps the
    // live figure (meter - baseline) climbing correctly between rebases,
    // instead of freezing at whatever Insights last knew.
    const usable = sorted.length > 1 && meter !== null;

    if (usable) {
      this.baselineKwh = Math.min(meter, Math.max(0, meter - consumed));
      this.baselineIsGuess = false;
      this.persist();
    }

    // The last few entries, nearest NOW: their values must track the live meter.
    // If the log belonged to another channel they would not, and that comparison
    // is the only cheap way to catch it — a wrong log looks healthy on every
    // other criterion.
    const tail = sorted.slice(-3)
      .map(({ entry, date }) => `${date.toISOString()}=${entry.v}`)
      .join(' ');

    const message = `log=${entries.logId || '?'} — ${entries.length} entries, ${todays.length} today, `
      + `first=${first} at=${firstAt ? firstAt.toISOString() : null}, meter=${meter}, `
      + `naive=${first !== null && meter !== null ? (meter - first).toFixed(2) : '?'}, `
      + `consumed=${consumed.toFixed(2)} (rejected ${steps} impossible steps, ${drops} drops), `
      + `latest[${tail}], `
      + `baseline=${usable ? this.baselineKwh : 'unchanged (rejected)'}`;

    // This now runs every 10 minutes, so INFO on every pass would be ~144 lines
    // a day per channel — the log would be useless for everything else. INFO is
    // kept for the passes that actually carry news: the first of an app run, a
    // rejected artefact (the whole reason this code exists), and a refusal to
    // produce a figure at all. The routine "nothing unusual" pass is verbose.
    const notable = !this.loggedRebase || steps > 0 || drops > 0 || !usable;
    this.loggedRebase = true;
    if (notable) errlog.info(`${this.device.getName()}: rebase`, message);
    else errlog.debug(`${this.device.getName()}: rebase`, message);
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
