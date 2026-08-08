'use strict';

// Shared behaviour for every Imou camera in this app.
//
// Same split as the vacuums (lib/miio-vacuum-device.js): protocol logic lives
// here, the per-model difference — which switches a camera actually implements
// — lives in a small profile (lib/imou-ranger2c.js, lib/imou-cellpt.js). A
// profile supplies:
//
//   PRODUCT_ID   the channel's productId, used by the driver to filter the
//                account's device list down to this model at pairing time
//   SWITCHES     [{ capability, enableType }], each a straight boolean:
//                enable:true on the cloud side == the capability reading true
//   hasBattery   whether to poll getDevicePowerInfo
//
// Unlike the vacuums this is a CLOUD device: there is no local push, so the
// only way to notice a change made from the Imou Life phone app is to poll.
// The same "never mirror local state" instinct from CLAUDE.md applies here —
// a manual toggle writes the capability optimistically, but the next poll is
// always the one telling the truth, exactly like the vacuum reads status fresh
// every time rather than trusting what a flow last set.

const Homey = require('homey');
const errlog = require('./errlog');
const { getClient, registerCamera, unregisterCamera, getOnlineMap } = require('./imou-account');
const { ImouError } = require('./imou-client');

// Codes meaning "this specific camera cannot be reached right now", mirrored
// from probe/imou/sweep.js. Kept apart from every other failure: they must
// skip a capability write, never count toward FAILURES_BEFORE_UNAVAILABLE —
// marking the Homey device unavailable would grey the tile and hide
// alarm_offline right when a flow most wants to read it.
const OFFLINE_CODES = new Set(['DV1007', 'DV1004', 'SN000']);

// The real constraint is the account's free quota: 30,000 API requests per
// MONTH, shared by every camera on the account — not 20,000/day as an earlier
// version of this comment claimed (that number belonged to a different,
// per-interface limit, not the account's total). At 5 cameras that leaves
// very little room: privacy mode and PIR detection are set-and-forget
// toggles, so this trades freshness for headroom rather than the other way
// round. 20 minutes, with the online check batched (see imou-account.js) and
// the battery read decoupled below, comes out to roughly 23,000 calls/month —
// leaving margin for writes, pairing and manual probing without going anywhere
// near the free tier's ceiling. Reducing this multiplies call volume directly.
const DEFAULT_POLL_SECONDS = 1200;
const FAILURES_BEFORE_UNAVAILABLE = 3;

// Battery drains slowly by nature (these are the solar Cell PTs), so reading
// it on every poll would double the account's call volume for freshness
// nobody needs. Read every 6th cycle instead — roughly every 2 hours at the
// default interval — everything else still polls at the full rate.
const BATTERY_EVERY = 6;

// How long a switch we just wrote is allowed to disagree with what the cloud
// reports before we believe the cloud.
//
// NOT based on a confirmed measurement — an attempt to time the read-side lag
// live was confounded by the network flakiness already on record in
// docs/fingerprints.md and possibly by testing while the Imou Life app was
// open on the same camera, and did not produce a trustworthy number. This is
// a short, cheap safety margin instead: without it, a flow that flips privacy
// mode and a poll landing right after could read an echo of the pre-write
// state and flip the tile straight back before the next poll corrects it.
// Inside the window a contradicting remote value is ignored; a matching one
// closes the window early; past the window the cloud always wins, so a write
// that silently failed still self-corrects.
const WRITE_GRACE = 45 * 1000;

class ImouCameraDevice extends Homey.Device {
  // Subclasses return their profile module.
  get profile() {
    throw new Error('Imou camera driver must define a profile');
  }

  async onInit() {
    this.failures = 0;
    this.pollCount = 0; // drives BATTERY_EVERY
    this.lastValues = {}; // capability -> last polled value, for change triggers
    this.pendingWrites = {}; // capability -> { value, until }, see WRITE_GRACE

    registerCamera(this.deviceId());

    await this.migrateCapabilities();
    this.registerSwitchCapabilities();

    this.poll();
    this.startPolling();
  }

  async migrateCapabilities() {
    // Same reasoning as the vacuum base class: a device paired before a
    // capability was added keeps its old list until this runs once.
    const manifest = this.driver.manifest || {};
    const wanted = manifest.capabilities || [];

    for (const cap of wanted) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error(`addCapability ${cap}`, err);
          errlog.add(`addCapability ${cap}`, err);
        }
      }
    }
    for (const cap of this.getCapabilities()) {
      if (!wanted.includes(cap)) {
        try {
          await this.removeCapability(cap);
        } catch (err) {
          this.error(`removeCapability ${cap}`, err);
          errlog.add(`removeCapability ${cap}`, err);
        }
      }
    }
  }

  // The manual toggle on the device tile IS registerCapabilityListener — a
  // flow action calls the same setSwitch() below, so both paths behave alike.
  registerSwitchCapabilities() {
    for (const sw of this.profile.SWITCHES) {
      this.registerCapabilityListener(sw.capability, (value) => this.setSwitch(sw, value));
    }
  }

  startPolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    const seconds = Number(this.getSetting('poll_interval')) || DEFAULT_POLL_SECONDS;
    this.pollTimer = this.homey.setInterval(() => this.poll(), seconds * 1000);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this.homey.setTimeout(() => this.startPolling(), 100);
    }
  }

  client() {
    const api = getClient(this.homey);
    if (!api) throw new Error(this.homey.__('imou.not_configured'));
    return api;
  }

  deviceId() {
    return this.getData().id;
  }

  channelId() {
    return this.getStoreValue('channelId') || '0';
  }

  note(context, message) {
    this.log(context, message);
    errlog.info(`${this.getName()}: ${context}`, message);
  }

  async poll() {
    const deviceId = this.deviceId();
    const channelId = this.channelId();

    try {
      const api = this.client();
      this.pollCount += 1;

      // Informational only — solar Cell PT cameras spend a lot of their time
      // in a power-saving state ('sleep', not 'offline'), and switch reads
      // work fine regardless (confirmed live). So this drives ONLY the
      // alarm_offline capability, never a decision to skip the switch reads
      // below — that used to be gated on it, and it made every solar camera's
      // switches freeze the moment it stepped out of the plain-online state.
      //
      // Shared across every camera (see imou-account.js): the first device to
      // poll each cycle pays for one deviceBaseDetailList call covering all of
      // them, the rest reuse it from the short-lived cache.
      const onlineMap = await getOnlineMap(this.homey);
      // A deviceId absent from the reply (should not happen once registered,
      // but a fresh pairing racing the cache is possible) is not evidence of
      // anything — default to "online" rather than raising a false alarm.
      const online = onlineMap.has(deviceId) ? onlineMap.get(deviceId) : true;
      await this.applyOnline(online);

      for (const sw of this.profile.SWITCHES) {
        try {
          const value = await api.getSwitch(deviceId, sw.enableType, channelId);
          await this.applyValue(sw.capability, value);
        } catch (err) {
          if (err instanceof ImouError && OFFLINE_CODES.has(err.code)) {
            // The camera itself refused this one read. Leave the capability at
            // its last known value rather than guessing, and do not let this
            // count as a poll failure — alarm_offline already says why.
            continue;
          }
          throw err; // a real transport/API problem — let the outer catch handle it
        }
      }

      if (this.profile.hasBattery && this.pollCount % BATTERY_EVERY === 1) {
        try {
          const power = await api.powerInfo(deviceId);
          const entry = (power.electricitys || []).find((e) => e.type === 'battery');
          if (entry && entry.electric !== undefined && entry.electric !== '') {
            await this.setCapabilityValue('measure_battery', Number(entry.electric)).catch(() => {});
          }
          // A camera can answer with no battery entry at all (mains-powered, or
          // solar panel actively topping it up at the moment of the read) —
          // silently skipped rather than writing a bogus 0, which would read as
          // "flat" on the tile.
        } catch (err) {
          if (!(err instanceof ImouError && OFFLINE_CODES.has(err.code))) throw err;
        }
      }

      this.failures = 0;
      if (!this.getAvailable()) {
        this.note('reachable again', 'the camera answered');
        await this.setAvailable();
      }
    } catch (err) {
      this.failures += 1;
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE && this.getAvailable()) {
        this.note('unreachable', `no reply after ${this.failures} polls: ${err.message}`);
        await this.setUnavailable(this.homey.__('imou.unreachable')).catch(() => {});
      }
    }
  }

  // The camera's own online state, which is NOT the same thing as the device
  // being available in Homey:
  //
  //   alarm_offline  — the Imou cloud says this camera is down (unplugged,
  //                    off Wi-Fi, battery flat). The device stays available so
  //                    flows can still read the flag and react to it.
  //   setUnavailable — we cannot reach the Imou cloud at all (bad credentials,
  //                    no internet). Nothing can be known about the camera.
  //
  // Conflating them would grey out the tile exactly when a flow most wants to
  // read "is my camera down?".
  async applyOnline(online) {
    const wasOffline = this.getCapabilityValue('alarm_offline');
    await this.setCapabilityValue('alarm_offline', !online).catch((err) => {
      this.error('set alarm_offline', err);
      errlog.add('set alarm_offline', err);
    });

    // First poll after a restart adopts the state without firing: wasOffline is
    // null then, and a flow should not announce an outage that began yesterday.
    if (wasOffline === null || wasOffline === undefined) return;
    if (wasOffline === !online) return;

    if (!online) this.note('offline', 'the Imou cloud reports this camera as offline');
    else this.note('online', 'the camera is back online');

    await this.homey.flow
      .getDeviceTriggerCard(online ? 'imou_came_online' : 'imou_went_offline')
      .trigger(this, {}, {})
      .catch(this.error);
  }

  // Writes the capability and fires the matching "changed" trigger, but only
  // on an actual change — not on every poll, which would spam the timeline the
  // same way an untoggled boolean would on the vacuums.
  async applyValue(capability, value) {
    const pending = this.pendingWrites[capability];
    if (pending) {
      if (Date.now() < pending.until && value !== pending.value) {
        // The cloud has not caught up to a write we made ourselves — believe
        // the write, not the read, and keep the window open rather than
        // adopting the stale value as truth.
        return;
      }
      // Either the cloud now agrees, or the grace window ran out — settled
      // either way, so stop overriding future reads for this capability.
      delete this.pendingWrites[capability];
    }

    const previous = this.lastValues[capability];
    this.lastValues[capability] = value;

    await this.setCapabilityValue(capability, value).catch((err) => {
      this.error(`set ${capability}`, err);
      errlog.add(`set ${capability}`, err);
    });

    if (previous === undefined || previous === value) return; // first poll or no change

    const card = CHANGE_TRIGGERS[capability];
    if (!card) return;
    await this.homey.flow
      .getDeviceTriggerCard(card)
      .trigger(this, {}, { [capability]: value })
      .catch(this.error);
  }

  // Used by both the capability listener (manual toggle / flow action) and by
  // runAction below. Optimistic: the cloud call succeeding is the confirmation,
  // and the next poll is what settles the tile if the cloud disagreed for any
  // reason (another client changed it a second later, say).
  async setSwitch(sw, value) {
    const api = this.client();
    await api.setSwitch(this.deviceId(), sw.enableType, value, this.channelId());

    // Arms the grace window (see WRITE_GRACE above) so a poll landing right
    // after this write cannot read a stale echo and flip the tile back.
    this.pendingWrites[sw.capability] = { value, until: Date.now() + WRITE_GRACE };

    this.lastValues[sw.capability] = value;
    await this.setCapabilityValue(sw.capability, value).catch(() => {});
  }

  // Flow action cards call this by capability name rather than by enableType,
  // so the card definitions in app.json never need to know the raw Imou string.
  async setSwitchByCapability(capability, value) {
    const sw = this.profile.SWITCHES.find((s) => s.capability === capability);
    if (!sw) throw new Error(`this camera has no ${capability} switch`);
    await this.setSwitch(sw, value);
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    unregisterCamera(this.deviceId());
  }
}

// capability -> trigger card id, both driver-agnostic since the cards are
// filtered by capability, not by driver_id (same reasoning as the vacuums:
// any future Imou model with the same capability inherits the card for free).
const CHANGE_TRIGGERS = {
  privacy_mode: 'imou_privacy_changed',
  motion_detection: 'imou_motion_changed',
};

module.exports = ImouCameraDevice;
