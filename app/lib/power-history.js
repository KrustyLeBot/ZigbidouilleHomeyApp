'use strict';

// Per-minute power history for one metered device, for the dashboard widget.
//
// Two sources, in this order:
//
//  1. BACKFILL at startup, from Homey's Insights via the Web API — this is
//     what reconstructs the part of today that happened before the app was
//     installed or restarted.
//  2. LIVE sampling every minute from the capability value.
//
// The app's own `homey.insights` manager is NOT the way in: its `getLog(id)`
// takes a lowercase-alphanumeric id and only returns logs the app CREATED
// itself. A device capability's log belongs to Homey core, so it is reachable
// only through HomeyAPI — which is why this app carries the
// `homey:manager:api` permission.
//
// Keeping our own per-minute record on top of that is still worth it: Insights
// downsamples, and this gives the widget one bucket per minute of the day,
// 1440 of them, at full resolution from the moment the app is running.
//
// Power is a LEVEL, not an event: between two Zigbee reports the load has not
// changed, so an unsampled minute holds the last known value rather than a
// gap. That is why this samples on a timer instead of only on report, and why
// the backfill forward-fills between Insights points.

const { HomeyAPI } = require('homey-api');
const { deviceUuid } = require('./device-uuid');
const errlog = require('./errlog');

const SLOTS = 1440; // minutes in a day
const SAMPLE_INTERVAL = 60 * 1000;
// Batched like errlog: a store write per minute is 1440 writes a day for
// nothing, since the in-memory copy is what serves the widget.
const FLUSH_INTERVAL = 5 * 60 * 1000;
const STORE_KEY = 'power_history';

function dayKey(date = new Date()) {
  // Local date, deliberately: "today" for the user is their midnight, not UTC's.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function minuteOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

// One HomeyAPI instance for the whole app: each channel would otherwise open
// its own, and building one costs a token fetch plus a local URL lookup.
let apiPromise = null;

function getApi(homey) {
  if (!apiPromise) {
    apiPromise = HomeyAPI.createAppAPI({ homey }).catch((err) => {
      apiPromise = null; // let a later device retry rather than cache a failure
      throw err;
    });
  }
  return apiPromise;
}

// Homey has changed how it names Insights periods before, and the valid set is
// not in the local API spec — so ask for the day, and fall back to a fixed
// 24 h window. Either way the entries are filtered to today's minutes below,
// so a wider window is harmless.
const RESOLUTIONS = ['today', 'last24Hours'];

async function fetchEntries(api, logId) {
  let lastError = null;
  for (const resolution of RESOLUTIONS) {
    try {
      const result = await api.insights.getLogEntries({ id: logId, resolution });
      // The endpoint's response shape is not in the spec: accept a bare array
      // as well as the { values: [...] } envelope.
      if (Array.isArray(result)) return result;
      if (result && Array.isArray(result.values)) return result.values;
      return [];
    } catch (err) {
      lastError = err;
    }
  }
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

class PowerHistory {
  constructor(device) {
    this.device = device;
    this.day = null;
    this.samples = new Array(SLOTS).fill(null);
    // meter_power reading as it stood at the first sample of the day, so
    // today's kWh is a delta against the device's own cumulative counter
    // rather than a total this class accumulates (which would drift and go
    // stale across restarts — see CLAUDE.md on mirroring device state).
    this.baselineKwh = null;
    this.sampleTimer = null;
    this.flushTimer = null;
    this.dirty = false;
  }

  async start() {
    await this.restore();
    this.sample();

    // Deliberately not awaited: reconstructing the day is a nice-to-have that
    // talks to the Web API, and onNodeInit must not wait on it — this device's
    // init is already the fragile part of pairing.
    this.backfill().catch((err) => {
      errlog.debug(`${this.device.getName()}: backfill`, err.message);
    });

    this.sampleTimer = this.device.homey.setInterval(() => this.sample(), SAMPLE_INTERVAL);
    this.flushTimer = this.device.homey.setInterval(() => this.flush(), FLUSH_INTERVAL);
  }

  // Fills today's missing minutes from Homey's Insights, so a freshly
  // installed or restarted app shows the whole day rather than starting from
  // a flat line at the moment it booted.
  //
  // Never overwrites a slot already recorded live: our own sample is at full
  // minute resolution, Insights is downsampled.
  async backfill() {
    const uuid = deviceUuid(this.device);
    if (!uuid) return;

    const api = await getApi(this.device.homey);
    const today = dayKey();

    const powerEntries = await fetchEntries(api, `homey:device:${uuid}:measure_power`);

    let filled = 0;
    let lastMinute = null;
    let lastValue = null;

    for (const entry of powerEntries) {
      const date = entryTime(entry);
      if (!date || dayKey(date) !== today) continue;
      if (typeof entry.v !== 'number') continue;

      const minute = minuteOfDay(date);

      // Forward-fill from the previous point. Insights buckets today into
      // steps of several minutes, so without this the chart would be a comb
      // of single-pixel bars separated by gaps — and since power is a level,
      // holding the previous value across the gap is the honest reading.
      if (lastMinute !== null) {
        for (let m = lastMinute + 1; m < minute; m++) {
          if (this.samples[m] === null || this.samples[m] === undefined) {
            this.samples[m] = Math.round(lastValue);
            filled++;
          }
        }
      }

      if (this.samples[minute] === null || this.samples[minute] === undefined) {
        this.samples[minute] = Math.round(entry.v);
        filled++;
      }

      lastMinute = minute;
      lastValue = entry.v;
    }

    // Re-baseline the day's kWh against the meter as it stood at 00:00, so the
    // headline figure covers the whole day too and not just since boot.
    let rebased = false;
    try {
      const meterEntries = await fetchEntries(api, `homey:device:${uuid}:meter_power`);
      const todays = meterEntries
        .filter((e) => {
          const date = entryTime(e);
          return date && dayKey(date) === today && typeof e.v === 'number';
        });
      if (todays.length) {
        this.baselineKwh = todays[0].v;
        rebased = true;
      }
    } catch (err) {
      // Keep the live baseline; the curve is still worth having.
      errlog.debug(`${this.device.getName()}: backfill kWh`, err.message);
    }

    if (filled || rebased) {
      this.dirty = true;
      await this.flush();
      this.device.log(`backfill: ${filled} minutes from Insights, kWh rebased=${rebased}`);
    }
  }

  stop() {
    if (this.sampleTimer) this.device.homey.clearInterval(this.sampleTimer);
    if (this.flushTimer) this.device.homey.clearInterval(this.flushTimer);
    this.sampleTimer = null;
    this.flushTimer = null;
  }

  async restore() {
    let stored = null;
    try {
      stored = this.device.getStoreValue(STORE_KEY);
    } catch (err) {
      // A missing/corrupt store is not worth failing init over: the history
      // simply restarts empty for today.
    }

    if (!stored || stored.day !== dayKey()) return; // yesterday's data, drop it

    this.day = stored.day;
    if (Array.isArray(stored.samples) && stored.samples.length === SLOTS) {
      this.samples = stored.samples;
    }
    if (typeof stored.baselineKwh === 'number') this.baselineKwh = stored.baselineKwh;
  }

  // Rotates at local midnight: a new day starts empty, and re-baselines the
  // kWh counter against wherever the device's total stands right now.
  rollover(today) {
    this.day = today;
    this.samples = new Array(SLOTS).fill(null);
    this.baselineKwh = this.readMeter();
    this.dirty = true;
  }

  readMeter() {
    const value = this.device.getCapabilityValue('meter_power');
    return typeof value === 'number' ? value : null;
  }

  sample() {
    const now = new Date();
    const today = dayKey(now);
    if (this.day !== today) this.rollover(today);

    // First run of a day that is already underway (fresh pairing, or an app
    // restart after a rollover we missed): anchor the baseline now. Today's
    // kWh then reads 0 and climbs, rather than showing the meter's lifetime
    // total — wrong, but wrong in the obvious direction.
    if (this.baselineKwh === null) this.baselineKwh = this.readMeter();

    const power = this.device.getCapabilityValue('measure_power');
    if (typeof power !== 'number') return;

    this.samples[minuteOfDay(now)] = Math.round(power);
    this.dirty = true;
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.device.setStoreValue(STORE_KEY, {
        day: this.day,
        samples: this.samples,
        baselineKwh: this.baselineKwh,
      });
    } catch (err) {
      // Best-effort: losing the persisted copy costs the day's history on the
      // next restart, never the running widget.
    }
  }

  // Shape consumed by the widget: only the minutes actually recorded, so the
  // payload stays small early in the day and the chart can place each bar at
  // its real time of day.
  toJSON() {
    const points = [];
    for (let minute = 0; minute < SLOTS; minute++) {
      const value = this.samples[minute];
      if (value !== null && value !== undefined) points.push([minute, value]);
    }

    const meter = this.readMeter();
    const kwh = (meter !== null && this.baselineKwh !== null)
      ? Math.max(0, meter - this.baselineKwh)
      : null;

    return { day: this.day, points, kwh, power: this.device.getCapabilityValue('measure_power') };
  }
}

module.exports = PowerHistory;
