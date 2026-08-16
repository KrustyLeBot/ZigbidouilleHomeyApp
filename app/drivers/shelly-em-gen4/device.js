'use strict';

const { CLUSTER } = require('zigbee-clusters');
const ZigbidouilleDevice = require('../../lib/zigbee-device');
const EnergyToday = require('../../lib/energy-today');

// Shelly EM Gen4 — one Zigbee node, three Homey devices:
//   root      -> channel 1 metering (measure_power + meter_power)
//   channel2  -> channel 2 metering (measure_power + meter_power)
//   relay     -> the dry contact (onoff)
//
// WHY split into three devices: Homey's `cumulative` energy flag is per-DEVICE,
// not per-channel. The user wants one clamp on the main incomer (cumulative =
// whole home) and one on a sub-load like heating (not cumulative). Those cannot
// coexist in one device, so each channel is its own Homey device with its own
// `cumulative` setting, applied at runtime via setEnergy(). See CLAUDE.md.
//
// Shelly's Zigbee firmware is new and its endpoint layout is NOT documented, so
// nothing here is hardcoded: the endpoints are DISCOVERED from the live node at
// init. Hardcoding 1/2/3 made onNodeInit throw on a node that numbers them
// differently, and a throwing init surfaces as "could not connect" at pairing.
// Every registration is best-effort: a missing cluster leaves one tile empty
// instead of killing the whole device. See docs/fingerprints.md for the
// interviewed layout.

// This device drops off the mesh regularly, so every exchange with it is
// time-boxed — an unanswered ZCL read otherwise leaves onNodeInit awaiting a
// promise that never settles, and the device stays half-initialised for good.
const METERING_READ_TIMEOUT = 10000;
const METERING_READ_ATTEMPTS = 3;
const METERING_RETRY_DELAY = 3000;
const REPORTING_CONFIG_TIMEOUT = 10000;
const REPORTING_CONFIG_ATTEMPTS = 3;
const REPORTING_RETRY_DELAY = 4000;
// Short on purpose: this is a relay the user is watching. A lost packet should
// surface as a quick failure they can retry, not as ten seconds of apparent
// lag — the mesh itself already retries underneath.
const RELAY_COMMAND_TIMEOUT = 4000;

// Sub-capability, so import and export are two separate registers on one tile.
const EXPORTED = 'meter_power.exported';

// currentSummationDelivered is a UINT48. Depending on how the ZCL layer decodes
// a 48-bit value it can surface as a Number, a BigInt, or a 6-byte Buffer, so
// coerce all three rather than assuming one. Returns null when there is nothing
// usable, which callers treat as "keep the previous value".
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (Buffer.isBuffer(value)) {
    // ZCL is little-endian; readUIntLE tops out at 6 bytes, exactly UINT48.
    return value.length ? value.readUIntLE(0, Math.min(value.length, 6)) : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// onOff is a ZCL boolean, but be tolerant about how it surfaces.
function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return null;
}

class ShellyEmGen4Device extends ZigbidouilleDevice {
  async onNodeInit({ zclNode }) {
    // The whole body is one try/catch, INCLUDING super.onNodeInit(): pairing
    // creates all three sub-devices from a single Zigbee join, and if any one
    // of them throws here (e.g. a cluster bind that times out while the mesh is
    // still settling right after join), it was aborting the entire pairing
    // transaction — matching "pairing fails 3 times out of 4". A failure here
    // must degrade one device, never kill the pairing.
    const { subDeviceId } = this.getData(); // undefined for the root (channel A)

    this.debugNote('init: start', `subDevice=${subDeviceId || 'root'}`);

    try {
      await super.onNodeInit({ zclNode });
      this.debugNote('init: super ok', 'ZigBeeDevice initialised');

      // Logged by the root device only — the layout is identical for all three
      // sub-devices, so logging it in each was the same line three times over.
      // Worth keeping at all because a wrong endpoint map is this driver's
      // historic failure mode, and `raw` carries the node's own descriptor to
      // compare against.
      const layout = this.discoverEndpoints(zclNode);
      if (!subDeviceId) this.note('init: layout', JSON.stringify(layout));
      else this.debugNote('init: layout', JSON.stringify(layout));

      // The endpoint probe has served its purpose and is gone — see
      // docs/fingerprints.md for the full result table it produced. It is not
      // left running because probing onOff on ep1/ep2 made the device stop
      // answering entirely for ~10s, which is almost certainly the same
      // firmware fault behind "the Shelly drops off the network when the dry
      // contact is switched".

      if (subDeviceId === 'relay') {
        if (layout.relay === null) {
          this.note('init: relay', 'no onOff cluster found — tile stays inert');
          return;
        }
        await this.setupRelay(zclNode, layout.relay);
        return;
      }

      // Channel A = ep2 (CT clamp 1), channel B = ep3 (CT clamp 2).
      // The previous code deliberately swapped these because, with the wrong
      // endpoint list, channel A was landing on the relay endpoint and the
      // readings appeared inverted. With the correct layout the natural order
      // is right, so the swap is gone.
      const endpoint = subDeviceId === 'channel2' ? layout.metering[1] : layout.metering[0];
      if (endpoint === undefined) {
        this.note('init: channel', 'no metering endpoint available for this channel');
      } else {
        await this.registerEnergyChannel(zclNode, endpoint);
      }

      await this.applyCumulative();

      // Today's imported energy, for the dashboard widget. Metering channels
      // only — the relay sub-device has no meter to read.
      if (this.hasCapability('meter_power')) {
        this.energyToday = new EnergyToday(this);
        await this.energyToday.start();
      }

      this.debugNote('init: done', `cumulative=${Boolean(this.getSetting('cumulative'))}`);
    } catch (err) {
      // Never rethrow: a failed mapping must not make the device (or the whole
      // pairing transaction it is part of) unavailable.
      this.recordError(`onNodeInit (${subDeviceId || 'root'})`, err);
    }
  }

  // Logged so a device that disappears from the network leaves a trace, which
  // is the symptom being chased with the dry contact.
  async onDeleted() {
    if (this.energyToday) this.energyToday.stop();
    this.note('deleted', 'device removed from Homey');
  }

  // Timers are Homey-managed, but stopping them here keeps a reloaded app from
  // running two samplers against the same device.
  async onUninit() {
    if (this.energyToday) this.energyToday.stop();
  }

  // Read by the dashboard widget's api.js.
  getEnergyToday() {
    return this.energyToday ? this.energyToday.toJSON() : null;
  }

  // Read by lib/energy-today.js: false whenever registerEnergyChannel skipped
  // meter_power registration this session (see the flag's own comment there).
  // Devices without this method (the virtual kwh-meter) are always live —
  // energy-today.js treats a missing method as "trust it".
  isMeterLive() {
    return Boolean(this.meterLive);
  }

  // NOTE: there is no way for a device to rename itself in Homey SDK v3 —
  // Device has no setName() method (confirmed against the SDK docs). A
  // previous attempt at auto-renaming the root device to "Channel A" called a
  // method that does not exist and silently failed every single run, flooding
  // the error panel. The root device keeps the driver's picker name ("Shelly
  // EM Gen4"); rename it by hand once after pairing if "Channel A" is wanted.

  // The relay tile flips back to its old value straight after being tapped,
  // which is Homey reverting an optimistic update because the command failed.
  // registerCapability alone gave no clue: it is synchronous and reports
  // nothing about whether the device can actually be commanded. So: probe the
  // cluster, and own the command handler to surface the real error.
  async setupRelay(zclNode, endpoint) {
    const cluster = zclNode.endpoints[endpoint].clusters[CLUSTER.ON_OFF.NAME];

    // Does this endpoint answer at all? ep1 already answers UNSUPPORTED_CLUSTER
    // to everything, so it is worth knowing whether ep3 is any different.
    try {
      const attrs = await this.withTimeout(
        cluster.readAttributes(['onOff']),
        METERING_READ_TIMEOUT,
        `read onOff ep${endpoint}`,
      );
      const state = toBoolean(attrs.onOff);
      this.debugNote(`relay read @ep${endpoint}`, `onOff=${String(attrs.onOff)} parsed=${state}`);
      if (state !== null) await this.setCapabilityValue('onoff', state).catch(() => {});
      // The endpoint answered, so clear any previous "unsupported" state.
      await this.setAvailable().catch(() => {});
    } catch (err) {
      this.recordError(`read onOff @ep${endpoint}`, err);
    }

    // Own the command path so a failure is logged with its real reason instead
    // of silently bouncing the tile back.
    this.registerCapabilityListener('onoff', async (value) => {
      try {
        await this.withTimeout(
          value ? cluster.setOn() : cluster.setOff(),
          RELAY_COMMAND_TIMEOUT,
          `set relay ${value ? 'on' : 'off'}`,
        );
        this.debugNote(`relay set @ep${endpoint}`, `${value ? 'on' : 'off'} accepted`);
      } catch (err) {
        this.recordError(`relay set ${value ? 'on' : 'off'} @ep${endpoint}`, err);
        throw err; // let Homey revert the tile — but now the reason is logged
      }
    });

    // Keep the tile in sync when the relay is switched outside Homey.
    try {
      await this.withTimeout(
        this.configureAttributeReporting([{
          endpointId: endpoint,
          cluster: CLUSTER.ON_OFF,
          attributeName: 'onOff',
          minInterval: 0,
          maxInterval: 600,
          minChange: 1,
        }]),
        REPORTING_CONFIG_TIMEOUT,
        `configureAttributeReporting onOff ep${endpoint}`,
      );
    } catch (err) {
      this.recordError(`relay reporting FAILED @ep${endpoint}`, err);
    }
  }

  // The real layout, from the Zigbee2MQTT converter for this exact model
  // (S4EM-002CXCEU, PR Koenkk/zigbee-herdsman-converters#12245):
  //
  //   ep1 = the built-in relay (genOnOff)   <- the dry contact
  //   ep2 = CT clamp channel 1 (metering)
  //   ep3 = CT clamp channel 2 (metering)
  //
  // This is NOT what the device's own simple descriptor says: it advertises
  // metering on ep1 and onOff on ep3, which is exactly backwards. Deriving the
  // layout from that descriptor (as this method used to) meant channel B was
  // reading the relay endpoint, the relay was being driven on a metering
  // endpoint, and the real second channel on ep3 was never read at all — which
  // produced the whole "only one channel works, relay is dead" conclusion.
  //
  // Hardcoded on purpose: the descriptor is known-wrong on this device, so
  // trusting it is worse than pinning the numbers a working implementation uses.
  discoverEndpoints(zclNode) {
    const endpoints = (zclNode && zclNode.endpoints) || {};
    const raw = {};
    for (const [epId, ep] of Object.entries(endpoints)) {
      raw[epId] = Object.keys((ep && ep.clusters) || {});
    }

    return { metering: [2, 3], relay: 1, raw };
  }

  // Each registration is independent and best-effort: on this device the two
  // readings may well come from different clusters, and one missing cluster
  // must not cost us the other tile.
  async registerEnergyChannel(zclNode, endpoint) {
    // Whether meter_power has a live reportParser wired up THIS session. Read
    // by EnergyToday: a day-boundary reading captured while this is false is a
    // frozen leftover from a previous session, not the true value at midnight,
    // and must not be trusted as a certain baseline. See the `!scale` branch
    // below for why registration can be skipped some sessions.
    this.meterLive = false;

    // Instantaneous power in W, signed: negative = exporting to the grid.
    this.registerMeasurePower(endpoint);

    // CONFIRMED BUG (interviewed 2026-07-30): this Shelly reports Metering
    // divisor = 1,000,000 (unusually large — most devices use 1 or 1000).
    // homey-zigbeedriver's built-in meter_power handling produced ~2.78 MWh for
    // a real ~2.78 kWh reading (raw currentSummationDelivered 2,777,998 with
    // multiplier 1) — a ~1000x inflation consistent with the library assuming a
    // divisor of 1000 instead of reading the device's actual value.
    const { scale, initialKWh } = await this.fetchMeteringScale(zclNode, endpoint);

    if (!scale) {
      // Registering with a guessed scale is worse than showing nothing: the
      // fallback divisor of 1 put a value a million times too large on the tile.
      // Deliberately NOT returning here: measure_power lives on a different
      // cluster (Electrical Measurement) that may work on this endpoint even
      // when Metering does not, so it still deserves its reporting configured.
      this.note(`meter_power @ep${endpoint}`, 'skipped — could not read multiplier/divisor');
      await this.verifyReporting(endpoint, null);
      return;
    }

    // Clear any "endpoint unsupported" state from a previous run: this endpoint
    // is answering now.
    await this.setAvailable().catch(() => {});

    this.registerMeterPower(endpoint, scale);
    this.meterLive = true;

    // Push the correctly-scaled value immediately rather than trust
    // getOpts.getOnStart to run it through our reportParser: whether the SDK's
    // own initial GET is parsed by our custom reportParser or by the library's
    // default (mis-scaled) one is not documented, and re-testing after the fix
    // showed no visible change — consistent with the initial GET bypassing our
    // parser. Setting it ourselves, from the same raw+scale read used to build
    // the parser, removes that ambiguity entirely.
    if (initialKWh !== null) {
      await this.setCapabilityValue('meter_power', initialKWh).catch((err) =>
        this.recordError('set meter_power initial', err));
    }

    // Exported energy, if this firmware counts it at all.
    await this.setupExportedEnergy(zclNode, endpoint, scale);

    // Confirm the device actually accepted the reporting configuration.
    await this.verifyReporting(endpoint, scale);

    // No polling: the device does push currentSummationDelivered on schedule.
    // A poll was added when the tile appeared frozen, but the reports were
    // arriving all along and being discarded by a broken reportParser (see
    // above). Polling a device that reports correctly is pure extra Zigbee
    // traffic — and this mesh is already fragile.
  }

  // Reads the Metering cluster's raw summation + its own multiplier/divisor, so
  // meter_power can be scaled correctly regardless of what the device reports
  // (this Shelly uses divisor 1,000,000; the ZCL spec allows any UINT24).
  //
  // Returns scale=null when the read fails. That is deliberate: falling back to
  // an identity scale (divisor 1) registered meter_power with a scale a MILLION
  // times off on this device. No reading is better than a wrong one.
  //
  // Retried, and every attempt is time-boxed: an unanswered readAttributes()
  // never settles, which hung onNodeInit forever — the device then finished
  // init only partially (measure_power registered, meter_power never reached)
  // and looked like "works right after pairing, then stops updating".
  async fetchMeteringScale(zclNode, endpoint) {
    const metering = zclNode.endpoints[endpoint].clusters[CLUSTER.METERING.NAME];
    if (!metering) return { scale: null, initialKWh: null };

    for (let attempt = 1; attempt <= METERING_READ_ATTEMPTS; attempt++) {
      try {
        const attrs = await this.withTimeout(
          metering.readAttributes(['currentSummationDelivered', 'multiplier', 'divisor']),
          METERING_READ_TIMEOUT,
          `readAttributes metering ep${endpoint}`,
        );

        const scale = {
          multiplier: Number(attrs.multiplier) || 1,
          divisor: Number(attrs.divisor) || 1,
        };
        const raw = toNumber(attrs.currentSummationDelivered);
        const initialKWh = raw === null ? null : (raw * scale.multiplier) / scale.divisor;

        // Verbose-only: the scale and the starting total are what you check
        // when bringing a channel up, and never again — at INFO this was two
        // lines per channel on every single restart.
        this.debugNote(`metering read @ep${endpoint}`, JSON.stringify({ scale, raw, initialKWh }));
        return { scale, initialKWh };
      } catch (err) {
        // Seen on this unit's endpoint 1: UNSUPPORTED_CLUSTER despite the
        // cluster being listed in the simple descriptor, and plain timeouts
        // whenever the device has dropped off the mesh.
        this.recordError(`read metering @ep${endpoint} (try ${attempt}/${METERING_READ_ATTEMPTS})`, err);
        if (attempt < METERING_READ_ATTEMPTS) await this.delay(METERING_RETRY_DELAY);
      }
    }

    return { scale: null, initialKWh: null };
  }

  // Exported energy — what a clamp on the main incomer pushes BACK to the grid.
  //
  // `meter_power` reads currentSummationDelivered, which only ever climbs on
  // import: with solar the watts go negative but the kWh total does not move.
  // Export accumulates in a separate attribute, currentSummationReceived, which
  // the ZCL spec marks OPTIONAL — so it is probed rather than assumed.
  //
  // Probed with its OWN read, not appended to fetchMeteringScale's: an
  // unsupported attribute in a multi-attribute read can fail the whole request,
  // and losing multiplier/divisor would cost us the import reading too. This
  // read is allowed to fail; that is the answer, not an error.
  //
  // The capability is added/removed to match what the device actually feeds —
  // a declared-but-never-written meter_power.exported would sit on "-" forever,
  // which is indistinguishable from "you have never exported anything".
  async setupExportedEnergy(zclNode, endpoint, scale) {
    const metering = zclNode.endpoints[endpoint].clusters[CLUSTER.METERING.NAME];
    let raw = null;

    try {
      const attrs = await this.withTimeout(
        metering.readAttributes(['currentSummationReceived']),
        METERING_READ_TIMEOUT,
        `read currentSummationReceived ep${endpoint}`,
      );
      raw = toNumber(attrs.currentSummationReceived);
    } catch (err) {
      // UNSUPPORTED_ATTRIBUTE here is a real answer: this firmware does not
      // count export. A timeout is NOT — it proves nothing (see CLAUDE.md), so
      // the capability is left exactly as it is and the next restart re-probes.
      const unsupported = /UNSUPPORTED_ATTRIBUTE/i.test(String(err && err.message));
      this.note(
        `exported energy @ep${endpoint}`,
        unsupported ? 'not supported by this firmware' : `probe inconclusive: ${err.message}`,
      );
      if (unsupported) await this.dropExportedCapability();
      return;
    }

    if (raw === null) {
      this.note(`exported energy @ep${endpoint}`, 'attribute present but unreadable — skipped');
      return;
    }

    if (!this.hasCapability(EXPORTED)) {
      // Devices paired before this capability existed keep their old list;
      // migrateCapabilities() deliberately skips multi-sub-device drivers, so
      // adding it here is what makes the tile appear without re-pairing.
      try {
        await this.addCapability(EXPORTED);
      } catch (err) {
        this.recordError(`addCapability ${EXPORTED}`, err);
        return;
      }
    }

    // Same scale as the import register — both are UINT48 in the cluster's own
    // units, so the device's multiplier/divisor applies unchanged.
    // Verbose-only for the same reason: the probe SUCCEEDING is routine. Its
    // two failure paths above stay at INFO, since those change what the tile can
    // show.
    this.debugNote(
      `exported energy @ep${endpoint}`,
      JSON.stringify({ raw, kWh: (raw * scale.multiplier) / scale.divisor }),
    );

    try {
      this.registerCapability(EXPORTED, CLUSTER.METERING, {
        endpoint,
        report: 'currentSummationReceived',
        reportParser: (report) => {
          const value = report !== null
            && typeof report === 'object'
            && !Buffer.isBuffer(report)
            && 'currentSummationReceived' in report
            ? report.currentSummationReceived
            : report;

          const parsed = toNumber(value);
          this.debugNote(`report ${EXPORTED} @ep${endpoint}`, `raw=${String(value)}`);
          if (parsed === null) return null;
          return (parsed * scale.multiplier) / scale.divisor;
        },
      });
    } catch (err) {
      this.recordError(`register ${EXPORTED} @ep${endpoint}`, err);
      return;
    }

    await this.setCapabilityValue(EXPORTED, (raw * scale.multiplier) / scale.divisor)
      .catch((err) => this.recordError(`set ${EXPORTED} initial`, err));
  }

  async dropExportedCapability() {
    if (!this.hasCapability(EXPORTED)) return;
    await this.removeCapability(EXPORTED)
      .catch((err) => this.recordError(`removeCapability ${EXPORTED}`, err));
  }

  // Rejects rather than hanging forever when the device never answers.
  withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = this.homey.setTimeout(
        () => reject(new Error(`timeout after ${ms}ms: ${label}`)),
        ms,
      );
      promise.then(
        (value) => { this.homey.clearTimeout(timer); resolve(value); },
        (err) => { this.homey.clearTimeout(timer); reject(err); },
      );
    });
  }

  delay(ms) {
    return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
  }

  // Instantaneous power, with an OWN reportParser — the library's default one
  // for measure_power/electricalMeasurement contains:
  //
  //     if (value < 0) return null;
  //
  // and `null` means "no update" to Homey. On a CT clamp sitting on the main
  // incomer that is wrong the moment production exceeds consumption: every
  // export reading is dropped and the tile freezes on the last positive value,
  // silently, exactly like the meter_power parser bug did. activePower is an
  // int16 in the ZCL spec precisely so it can go negative, so the sign is kept.
  //
  // Scaling is deliberately left at 1 (what the library also does when
  // acPowerMultiplier/acPowerDivisor were never read): the observed watts match
  // the Shelly's own display, and this device has already proved that trusting
  // an unverified device-reported scale is how readings end up orders of
  // magnitude off. Only the sign handling changes here.
  registerMeasurePower(endpoint) {
    try {
      this.registerCapability('measure_power', CLUSTER.ELECTRICAL_MEASUREMENT, {
        endpoint,
        get: 'activePower',
        getOpts: { getOnStart: true },
        report: 'activePower',
        reportParser: (report) => {
          const value = report !== null
            && typeof report === 'object'
            && !Buffer.isBuffer(report)
            && 'activePower' in report
            ? report.activePower
            : report;

          const raw = toNumber(value);
          this.debugNote(`report measure_power @ep${endpoint}`, `raw=${String(value)}`);
          if (raw === null) return null; // keep the previous value
          return raw;
        },
        // Reporting is configured by verifyReporting(), not here — see the note
        // in registerMeterPower about configuring the same attribute twice.
      });
    } catch (err) {
      this.recordError(`register measure_power @ep${endpoint}`, err);
    }
  }

  // Ongoing updates only; the initial value is set explicitly above.
  //
  // configureAttributeReporting is what makes the device PUSH updates. Without
  // it the driver only ever listened for reports the device was never asked to
  // send, so the tiles showed the value read once at init and then froze — the
  // "correct value, never updates" symptom. minChange is in RAW units, so with
  // divisor 1,000,000 a minChange of 1000 is 0.001 kWh (1 Wh) of real change.
  registerMeterPower(endpoint, scale) {
    try {
      this.registerCapability('meter_power', CLUSTER.METERING, {
        endpoint,
        report: 'currentSummationDelivered',
        // reportParser receives the attribute's VALUE, not an object keyed by
        // attribute name. Reading `report.currentSummationDelivered` gave
        // undefined on every single report, so the parser returned null and the
        // capability was never updated — which looked exactly like "the device
        // accepts reporting then never sends anything". It always sent them.
        // The object form is still accepted defensively, since the SDK docs
        // show that shape for other capabilities.
        reportParser: (report) => {
          const value = report !== null
            && typeof report === 'object'
            && !Buffer.isBuffer(report)
            && 'currentSummationDelivered' in report
            ? report.currentSummationDelivered
            : report;

          const raw = toNumber(value);
          // Verbose-only: proves whether reports actually ARRIVE for this
          // endpoint. Reads work without a Zigbee binding but reports do not,
          // so "reads fine, never updates" is the signature of a missing
          // binding — and bindings are only written at pairing time.
          this.debugNote(`report meter_power @ep${endpoint}`, `raw=${String(value)}`);
          if (raw === null) return null; // keep the previous value
          return (raw * scale.multiplier) / scale.divisor;
        },
        // No reportOpts: verifyReporting() configures this very attribute
        // explicitly and awaits the answer. Doing both sent ConfigureReporting
        // twice for one attribute — and the device then answered with bursts of
        // four identical reports 3 s apart, despite a 60 s minInterval.
      });
    } catch (err) {
      this.recordError(`register meter_power @ep${endpoint}`, err);
    }
  }

  // registerCapability() is synchronous: it only records the INTENT to report.
  // The actual ConfigureReporting exchange happens later and can fail silently,
  // which is why tiles sat frozen while the log claimed "reporting configured".
  // Doing it explicitly and awaiting the result makes success/failure visible.
  async verifyReporting(endpoint, scale) {
    const attributes = [
      {
        endpointId: endpoint,
        cluster: CLUSTER.ELECTRICAL_MEASUREMENT,
        attributeName: 'activePower',
        minInterval: 10,
        maxInterval: 300,
        minChange: 1,
      },
    ];

    if (scale) {
      attributes.push({
        endpointId: endpoint,
        cluster: CLUSTER.METERING,
        attributeName: 'currentSummationDelivered',
        minInterval: 60, // never more than once a minute
        // Heartbeat kept fairly short (5 min rather than 15) so a stalled meter
        // is obvious quickly: this device is not trusted to honour minChange,
        // and with a long heartbeat a silent tile is indistinguishable from a
        // genuinely idle one. Energy is cumulative, so a missed report costs
        // nothing — the next one carries the full total anyway.
        maxInterval: 300,
        minChange: Math.max(1, Math.round(scale.divisor / 1000)), // ~1 Wh
      });

      // Only when the probe found the attribute — asking a device to report an
      // attribute it does not implement earns an error, and on this unit an
      // error mid-burst is enough to make it stop answering for a while.
      if (this.hasCapability(EXPORTED)) {
        attributes.push({
          endpointId: endpoint,
          cluster: CLUSTER.METERING,
          attributeName: 'currentSummationReceived',
          minInterval: 60,
          maxInterval: 300,
          minChange: Math.max(1, Math.round(scale.divisor / 1000)), // ~1 Wh
        });
      }
    }

    for (const attribute of attributes) {
      const label = `${attribute.attributeName} @ep${endpoint}`;
      let lastError = null;

      // Retried: three sub-devices initialise at once and this call has been
      // seen to simply time out when it lands last in that burst — which left
      // one channel's kWh unreported until the next restart. A timeout is not a
      // refusal, so it is worth asking again after letting the radio settle.
      for (let attempt = 1; attempt <= REPORTING_CONFIG_ATTEMPTS; attempt++) {
        try {
          await this.withTimeout(
            this.configureAttributeReporting([attribute]),
            REPORTING_CONFIG_TIMEOUT,
            `configureAttributeReporting ${label}`,
          );
          this.debugNote(`reporting ok: ${label}`, `every ${attribute.minInterval}-${attribute.maxInterval}s`);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < REPORTING_CONFIG_ATTEMPTS) await this.delay(REPORTING_RETRY_DELAY);
        }
      }

      if (lastError) {
        // The device will simply never push this attribute; the tile keeps its
        // last value. Logged rather than thrown so one dead attribute does not
        // take the other down with it.
        this.recordError(`reporting FAILED: ${label}`, lastError);
      }
    }
  }

  // Translate the per-device `cumulative` setting into Homey's energy model.
  // A cumulative device is "the whole home": Homey subtracts every other metered
  // device from it and shows the remainder as "other". A non-cumulative meter is
  // just this load's own consumption — the default, so we clear the override
  // rather than pass cumulative:false (which the manifest schema forbids and the
  // runtime rejects the same way). setEnergy() overrides the manifest energy.
  //
  // When the clamp also counts export, the two registers are named explicitly:
  // without cumulativeExportedCapability Homey has no way to know which of the
  // two meter_power.* capabilities is which, and would read the total as pure
  // consumption — turning solar production into imported energy on the graph.
  async applyCumulative() {
    const cumulative = Boolean(this.getSetting('cumulative'));
    const energy = cumulative
      ? { cumulative: true, cumulativeImportedCapability: 'meter_power' }
      : {};
    if (cumulative && this.hasCapability(EXPORTED)) {
      energy.cumulativeExportedCapability = EXPORTED;
    }
    await this.setEnergy(energy).catch((err) => this.recordError('setEnergy', err));
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('cumulative')) await this.applyCumulative();
  }
}

module.exports = ShellyEmGen4Device;
