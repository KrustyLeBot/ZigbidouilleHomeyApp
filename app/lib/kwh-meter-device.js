'use strict';

// A virtual kWh meter: integrates one other device's `measure_power` (W) into
// a monotonic cumulative `meter_power` (kWh), so a source whose own energy
// object is missing or broken still gets a real breakdown in Homey Energy.
// One of these devices tracks exactly one source, fixed at pairing time
// (store.sourceId) — see drivers/kwh-meter/driver.js for how the source list
// is built.
//
// Homey Energy, its top-consumers list and Insights day/week/month/year all
// derive from differentiating a MONOTONIC meter_power. A counter that ever
// drops reads as negative consumption and corrupts that derivation — so
// cumulKWh here can only ever go up, never be reset, never be recomputed from
// scratch on a whim. The only two writes to it are "add a non-negative
// amount" (accumulate()) and "restore exactly what was persisted last".
//
// Integration is zero-order hold: between two readings, the load is assumed
// to have drawn the OLDER of the two the whole time. Good enough for the
// mixed bag of plugs and appliances this tracks; a sawtooth load (something
// that ramps rather than steps) would want a trapezoidal average instead, not
// implemented here since nothing paired so far needs it.

const errlog = require('./errlog');
const { getApi, onSourceDeleted, offSourceDeleted } = require('./kwh-meter-account');

// Two independent timers, easy to conflate:
//
//   SAMPLE_INTERVAL      how often this device closes an integration interval
//                        on its own, so a load that stops CHANGING (a pool
//                        pump humming at a constant wattage) still gets
//                        counted — measure_power only pushes on change.
//   CAP_DELTA_MS         a safety ceiling on any single interval's duration,
//                        regardless of why it got long (Homey reboot, the app
//                        restarting, a phone that slept through some ticks).
//                        Without it, the first tick after a long gap would
//                        integrate the last known wattage across the WHOLE
//                        gap, fabricating a spike that never happened.
const SAMPLE_INTERVAL = 30 * 1000;
const CAP_DELTA_MS = 10 * 60 * 1000;

// How long a source may sit unreachable before this stops assuming it is
// still drawing its last known wattage and starts assuming 0. Separate from
// CAP_DELTA_MS: this is about NOT knowing the load is still running, not
// about a gap in polling.
const OFFLINE_ZERO_AFTER_MS = 10 * 60 * 1000;

const KWH_DIVISOR = 3.6e9; // W * ms -> kWh
const STORE_KEY = 'kwh_meter_state';
const STORE_VERSION = 1;

class KwhMeterDevice extends require('homey').Device {
  async onInit() {
    this.cumulKWh = 0;
    this.lastPower = 0;
    this.lastTs = Date.now();
    this.sourceOffline = false;
    this.offlineSince = null;

    await this.restore();
    await this.connectSource();

    this.timer = this.homey.setInterval(() => this.tick(), SAMPLE_INTERVAL);
  }

  note(context, message) {
    this.log(context, message);
    errlog.info(`${this.getName()}: ${context}`, message);
  }

  sourceId() {
    return this.getStoreValue('sourceId');
  }

  async restore() {
    let stored = null;
    try {
      stored = this.getStoreValue(STORE_KEY);
    } catch (err) {
      // Missing/corrupt store: fall through to the fresh-install path below.
    }

    // Fresh install, or a record written by a format this build no longer
    // understands — starts at 0 rather than trusting a value whose meaning
    // might have changed. Same STORE_VERSION discipline as
    // lib/energy-today.js: never silently reinterpret an old record.
    if (!stored || stored.v !== STORE_VERSION) {
      this.cumulKWh = 0;
      this.lastPower = 0;
      this.lastTs = Date.now();
      await this.persist();
      return;
    }

    this.cumulKWh = typeof stored.cumulKWh === 'number' ? stored.cumulKWh : 0;
    this.lastPower = typeof stored.lastPower === 'number' ? stored.lastPower : 0;
    // Reboot / app restart: the elapsed downtime's power draw is unknown, not
    // zero and not the last known value either — so it is simply never
    // integrated. Restarting the clock at now (rather than at the old
    // lastTs) is what makes that "skip", not a fabricated guess.
    this.lastTs = Date.now();
  }

  async persist() {
    await this.setStoreValue(STORE_KEY, {
      v: STORE_VERSION,
      cumulKWh: this.cumulKWh,
      lastPower: this.lastPower,
    }).catch((err) => {
      this.error('persist', err);
      errlog.add(`${this.getName()}: persist failed`, err);
    });
  }

  async connectSource() {
    const id = this.sourceId();
    if (!id) {
      await this.setUnavailable(this.homey.__('kwh_meter.no_source')).catch(() => {});
      return;
    }

    try {
      const api = await getApi(this.homey);
      const source = await api.devices.getDevice({ id });
      this.source = source;

      // Live push, not a poll — matches the spec this driver was built from.
      this.capInstance = source.makeCapabilityInstance('measure_power', (value) => this.onPower(value));

      // Availability changes are expected to surface as an 'update' on the
      // device object — NOT yet confirmed live against a real source that
      // actually drops off Wi-Fi, only against the documented shape. If this
      // never fires, a genuinely offline source just keeps reporting its last
      // known wattage forever instead of zeroing after
      // OFFLINE_ZERO_AFTER_MS — degraded, not broken. Verify once a real
      // source goes offline; see docs/fingerprints.md.
      this.onSourceUpdate = () => this.applyAvailability(source.available !== false);
      source.on('update', this.onSourceUpdate);
      this.applyAvailability(source.available !== false);

      this.onSourceDeletedHandler = () => this.handleSourceDeleted();
      onSourceDeleted(id, this.onSourceDeletedHandler);

      if (!this.getAvailable()) await this.setAvailable().catch(() => {});
    } catch (err) {
      // The source is gone (deleted) or unreachable at init. Freeze the
      // counter rather than guess — cumulKWh is left exactly as restored.
      this.note('source unavailable at init', err.message);
      await this.setUnavailable(this.homey.__('kwh_meter.source_gone')).catch(() => {});
    }
  }

  async handleSourceDeleted() {
    this.note('source deleted', 'freezing the counter, no more integration');
    this.detachSource();
    await this.setUnavailable(this.homey.__('kwh_meter.source_gone')).catch(() => {});
  }

  detachSource() {
    if (this.capInstance && typeof this.capInstance.destroy === 'function') {
      try {
        this.capInstance.destroy();
      } catch (err) {
        // best-effort teardown
      }
    }
    this.capInstance = null;
    if (this.source && this.onSourceUpdate) {
      try {
        this.source.off('update', this.onSourceUpdate);
      } catch (err) {
        // best-effort teardown
      }
    }
    this.source = null;
    if (this.onSourceDeletedHandler) {
      offSourceDeleted(this.sourceId(), this.onSourceDeletedHandler);
      this.onSourceDeletedHandler = null;
    }
  }

  applyAvailability(available) {
    if (available) {
      if (this.sourceOffline) this.note('source back online', '');
      this.sourceOffline = false;
      this.offlineSince = null;
      return;
    }
    if (!this.sourceOffline) {
      this.sourceOffline = true;
      this.offlineSince = Date.now();
      this.note('source offline', `holding last known power, zeroing after ${OFFLINE_ZERO_AFTER_MS / 60000} min`);
    }
  }

  // A genuine measure_power push. Closes the prior interval at the OLD
  // lastPower first (that is what "zero-order hold" means — the new value
  // only takes effect from this instant forward), then adopts the new value.
  onPower(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    const now = Date.now();
    this.accumulate(now);
    this.lastPower = value;
    this.applyAvailability(true); // a fresh reading is proof the source is up
    this.pushCapabilities();
    this.persist();
  }

  // The periodic safety net: closes an interval even when measure_power
  // never fired (a load that stopped CHANGING, not stopped drawing power).
  async tick() {
    const now = Date.now();
    this.accumulate(now, this.effectivePower(now));
    await this.pushCapabilities();
    await this.persist();
  }

  // What power to assume RIGHT NOW: the last real reading, unless the source
  // has been offline long enough that assuming it is still there would be a
  // bigger lie than assuming it is off.
  effectivePower(now) {
    if (!this.sourceOffline) return this.lastPower;
    const offlineFor = now - this.offlineSince;
    return offlineFor >= OFFLINE_ZERO_AFTER_MS ? 0 : this.lastPower;
  }

  // The integration itself. `power` defaults to the last known reading
  // (zero-order hold); dt is capped so a long gap can never fabricate a
  // spike, and never allowed negative so a backward clock step adds nothing.
  // Only ever ADDS a non-negative amount to cumulKWh — that is the entire
  // monotonicity guarantee, and it is enforced structurally here rather than
  // by checking the result afterwards.
  accumulate(now, power = this.lastPower) {
    let dt = now - this.lastTs;
    if (dt < 0) dt = 0;
    if (dt > CAP_DELTA_MS) dt = CAP_DELTA_MS;
    if (dt > 0 && power > 0) {
      this.cumulKWh += (power * dt) / KWH_DIVISOR;
    }
    this.lastTs = now;
  }

  async pushCapabilities() {
    await this.setCapabilityValue('meter_power', this.cumulKWh).catch((err) => {
      this.error('set meter_power', err);
      errlog.add(`${this.getName()}: set meter_power failed`, err);
    });
    await this.setCapabilityValue('measure_power', this.effectivePower(Date.now())).catch(() => {});
  }

  async onDeleted() {
    if (this.timer) this.homey.clearInterval(this.timer);
    this.detachSource();
  }
}

module.exports = KwhMeterDevice;
