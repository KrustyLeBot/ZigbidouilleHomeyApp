'use strict';

// One PLAF301 (One RFID Smart Feeder): plays the Petlibro cloud's part for it.
//
// Protocol from smcneece/petlibro-local (docs/mqtt-protocol.md, devices.py),
// which built it from captures of the real cloud. Topics are
//   dl/<model>/<serial>/device/<channel>/{post: feeder -> us | sub: us -> feeder}
// with JSON bodies carrying cmd, ts (ms), msgId and, in replies, code (0 = ok).
//
// The cloud's duties this class takes over, because nothing else will:
// - answer the feeder's time requests (NTP) and keep its clock right — its
//   clock does not survive a reboot, and a wrong clock means wrong meal times;
// - acknowledge DEVICE_START_EVENT and GRAIN_OUTPUT_EVENT;
// - hand over the feeding plans when the feeder asks after a boot, and re-send
//   them whenever they change (an edit from Homey, a DST change) until acked;
// - poll the attributes every few minutes.
//
// It runs whether or not Homey is connected: meals must not depend on Homey.

const EventEmitter = require('events');
const log = require('./log');
const tz = require('./tz');
const plans = require('./plans');
const { textToFrames } = require('./display');

const MODEL = 'PLAF301';
const OFFLINE_AFTER_MS = 5 * 60 * 1000; // heartbeats come every ~90-100 s
const ATTR_POLL_MS = 5 * 60 * 1000;
const PLAN_RESEND_MS = 5 * 60 * 1000;
const PLAN_MAX_SENDS = 24; // 2 hours of re-sends without an ack, then wait for the feeder to ask
const MANUAL_FEED_WINDOW_MS = 2 * 60 * 1000;
// Clock correction, values from petlibro-local (tested on this model, fw 3.0.72).
const CLOCK_TOLERANCE_S = 30;
const CLOCK_FIX_INTERVAL_MS = 5 * 60 * 1000;
const CLOCK_FIX_MAX_TRIES = 3;
const CLOCK_FIX_BACKOFF_MS = 3600 * 1000;
const CLOCK_SLOW_HOLD_MAX_MS = 3600 * 1000;
const CLOCK_HOLD_SLACK_MS = 5000;
const NTP_SYNC_ACK_TIMEOUT_MS = 10000;
// errorCode 2032: the lid could not close (a pet in the way). The only code
// ever observed (petlibro-local, issue #7); anything else is reported raw.
const ERROR_LID_JAMMED = 2032;

// Settings Homey may change, and the exact field the feeder takes for each.
// Sent one field per message, as the Petlibro app does — bundling them made the
// feeder announce "settings saved" for things that had not changed.
const SETTING_FIELDS = {
  lidMode: { field: 'coverOpenMode', check: (v) => ['KEEP_CLOSE', 'CUSTOM', 'KEEP_OPEN'].includes(v) },
  lidCloseSpeed: { field: 'coverCloseSpeed', check: (v) => ['FAST', 'SLOW'].includes(v) },
  lidCloseDelay: { field: 'closeDoorTimeSec', check: (v) => Number.isInteger(v) && v >= 1 && v <= 10 },
  childLock: { field: 'childLockSwitch', check: (v) => typeof v === 'boolean' },
  sound: { field: 'soundSwitch', check: (v) => typeof v === 'boolean' },
  volume: { field: 'volume', check: (v) => Number.isInteger(v) && v >= 0 && v <= 100 },
};

class Feeder extends EventEmitter {
  constructor({ serial, store, publish, defaultTimezone }) {
    super();
    this.serial = serial;
    this.store = store;
    this.publishRaw = publish;
    this.defaultTimezone = defaultTimezone;
    this.model = MODEL;
    this.attrs = {};
    this.online = false;
    this.lastSeen = 0;
    this.lastAttrPoll = 0;
    this.pendingManualFeed = 0;
    this.nearSince = null;
    this.clockOffsetS = null;
    this.clockFix = { lastPush: 0, tries: 0, backoffUntil: 0, heldSince: null, lastHoldLog: 0 };
    this.ntpSyncPending = new Map();
    this.msgCounter = 0;
    this.persisted = store.feeder(serial);
  }

  // --- identity / state ---------------------------------------------------

  timezone() {
    const zone = this.persisted.schedule && this.persisted.schedule.timezone;
    return tz.isValidTimezone(zone) ? zone : this.defaultTimezone;
  }

  name() {
    return `Feeder ${this.serial.slice(-4)}`;
  }

  snapshot() {
    const a = this.attrs;
    const sched = this.persisted.schedule || null;
    return {
      serial: this.serial,
      model: this.model,
      online: this.online,
      lastSeen: this.lastSeen || null,
      firmware: this.persisted.firmware || null,
      hardware: this.persisted.hardware || null,
      rssi: typeof a.rssi === 'number' ? a.rssi : null,
      clockOffsetSeconds: this.clockOffsetS,
      battery: typeof a.electricQuantity === 'number' && a.electricQuantity > 0 ? a.electricQuantity : null,
      // powerType 2 = battery, 3 = mains, confirmed on this model by cutting the
      // power (petlibro-local). Any other value is reported as unknown.
      power: a.powerType === 2 ? 'battery' : a.powerType === 3 ? 'mains' : null,
      // surplusGrain is the hopper sensor: true = food present. The author of
      // petlibro-local calls it "not always reliable"; it is shown as is.
      foodLow: typeof a.surplusGrain === 'boolean' ? !a.surplusGrain : null,
      lidOpen: typeof a.barnDoorState === 'boolean' ? a.barnDoorState : null,
      lidJammed: Boolean(this.persisted.lidJammed),
      settings: {
        lidMode: a.coverOpenMode || null,
        lidCloseSpeed: a.coverCloseSpeed || null,
        lidCloseDelay: typeof a.closeDoorTimeSec === 'number' ? a.closeDoorTimeSec : null,
        childLock: typeof a.childLockSwitch === 'boolean' ? a.childLockSwitch : null,
        sound: typeof a.soundSwitch === 'boolean' ? a.soundSwitch : null,
        volume: typeof a.volume === 'number' ? a.volume : null,
        displayOn: typeof a.screenDisplaySwitch === 'boolean' ? a.screenDisplaySwitch : null,
        displayText: this.persisted.displayText || null,
      },
      schedule: sched ? {
        timezone: this.timezone(),
        meals: sched.meals,
        callSound: sched.callSound !== false,
        paused: Boolean(sched.paused),
        acked: Boolean(this.persisted.planAcked),
        wire: this.persisted.wirePlans || [],
      } : null,
      lastFeed: this.persisted.lastFeed || null,
      lastVisit: this.persisted.lastVisit || null,
    };
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  emitEvent(type, data = {}) {
    log.info(this.name(), Object.keys(data).length ? `${type} ${JSON.stringify(data)}` : type);
    this.emit('event', { type, t: Date.now(), ...data });
  }

  // --- MQTT plumbing --------------------------------------------------------

  topic(channel) {
    return `dl/${this.model}/${this.serial}/device/${channel}/sub`;
  }

  nextMsgId() {
    this.msgCounter = (this.msgCounter + 1) % 1000;
    return `${this.serial}_${Date.now()}${String(this.msgCounter).padStart(3, '0')}`;
  }

  send(channel, body) {
    const payload = { ts: Date.now(), ...body };
    this.publishRaw(this.topic(channel), payload);
    return payload;
  }

  // Commands go on service/sub. ATTR_SET_SERVICE unless the body names its own cmd.
  command(body) {
    return this.send('service', { cmd: 'ATTR_SET_SERVICE', msgId: this.nextMsgId(), ...body });
  }

  // --- incoming -------------------------------------------------------------

  handle(channel, data, wireModel) {
    if (wireModel && wireModel !== this.model) {
      log.info(this.name(), `talks on model ${wireModel}, not ${this.model}; commands follow it`);
      this.model = wireModel;
    }
    // A message carrying linkId was written by a cloud, not by the feeder.
    // Never act on one: echoing a reply back made a Polar re-run its command
    // in an endless loop (petlibro-local).
    if (data.linkId) return;
    this.markSeen();

    const { cmd } = data;
    switch (cmd) {
      case 'HEARTBEAT':
        if (typeof data.rssi === 'number') this.attrs.rssi = data.rssi;
        this.checkClock(data.ts);
        break;
      case 'NTP':
        this.answerNtp(data.ts);
        break;
      case 'NTP_SYNC':
        this.onNtpSyncAck(data);
        break;
      case 'DEVICE_START_EVENT':
        this.onStart(channel, data);
        break;
      case 'GET_FEEDING_PLAN_EVENT':
        this.answerPlanRequest();
        break;
      case 'FEEDING_PLAN_SERVICE':
        this.onPlanAck(data);
        break;
      case 'GRAIN_OUTPUT_EVENT':
        this.onGrainOutput(data);
        break;
      case 'MANUAL_FEEDING_SERVICE':
      case 'SWITCH_DOOR_SERVICE':
      case 'DISPLAY_MATRIX_SERVICE':
        if (data.code !== 0 && data.code !== undefined) {
          this.emitEvent('command_refused', { command: cmd, code: data.code });
        }
        break;
      case 'WAREHOUSE_DOOR_EVENT':
        this.onLid(data);
        break;
      case 'PET_IDENTIFY_EVENT':
        this.onPetIdentify(data);
        break;
      case 'ERROR_EVENT':
        this.onError(data);
        break;
      case 'ATTR_PUSH_EVENT':
      case 'ATTR_GET_SERVICE':
      case 'ATTR_SET_SERVICE':
        this.mergeAttrs(cmd, data);
        break;
      default:
        // Unknown messages are the interesting ones: logged once per cmd at
        // INFO so they show up with debug off, kept whole in the capture.
        if (!this.seenUnknown) this.seenUnknown = new Set();
        if (!this.seenUnknown.has(cmd)) {
          this.seenUnknown.add(cmd);
          log.info(this.name(), `unknown message "${cmd}" on ${channel} — see the capture`);
        }
    }
  }

  markSeen() {
    this.lastSeen = Date.now();
    if (!this.online) {
      this.online = true;
      this.emitEvent('online');
      this.pollAttrs();
      this.emitState();
    }
  }

  // Called every minute by the bridge.
  tick(now = Date.now()) {
    if (this.online && now - this.lastSeen > OFFLINE_AFTER_MS) {
      this.online = false;
      this.emitEvent('offline', { silentSeconds: Math.round((now - this.lastSeen) / 1000) });
      this.emitState();
    }
    if (this.online && now - this.lastAttrPoll >= ATTR_POLL_MS) this.pollAttrs();
    this.reconcilePlans(now);
  }

  pollAttrs() {
    this.lastAttrPoll = Date.now();
    this.send('service', { cmd: 'ATTR_GET_SERVICE', msgId: this.nextMsgId() });
  }

  mergeAttrs(cmd, data) {
    const skip = new Set(['cmd', 'msgId', 'code', 'ts', 'wifiSsid', 'wifiPassword']);
    // petlibro-local only trusts powerType from a push the feeder sends on its
    // own: a poll reply has only ever been seen saying "mains", and was never
    // captured during an outage. Same caution here.
    if (cmd === 'ATTR_GET_SERVICE') {
      skip.add('powerType');
      skip.add('powerMode');
    }
    const before = this.snapshot();
    for (const [k, v] of Object.entries(data)) if (!skip.has(k)) this.attrs[k] = v;
    const after = this.snapshot();

    if (before.power !== after.power && after.power) {
      if (before.power) this.emitEvent(after.power === 'battery' ? 'on_battery' : 'mains_restored');
    }
    if (before.foodLow !== after.foodLow && after.foodLow !== null && before.foodLow !== null) {
      this.emitEvent(after.foodLow ? 'food_low' : 'food_refilled');
    }
    if (before.lidOpen !== after.lidOpen && after.lidOpen === false && this.persisted.lidJammed) {
      this.clearJam();
    }
    this.emitState();
  }

  // --- boot / time ----------------------------------------------------------

  onStart(channel, data) {
    if (data.softwareVersion) this.persisted.firmware = data.softwareVersion;
    if (data.hardwareVersion) this.persisted.hardware = data.hardwareVersion;
    this.store.save();
    log.info(this.name(), `booted: fw=${data.softwareVersion} hw=${data.hardwareVersion} restartReason=${data.restartReason}`);
    this.send('event', { cmd: 'DEVICE_START_EVENT', msgId: data.msgId || '', code: 0 });
    this.emitEvent('booted', { firmware: data.softwareVersion || null });
    this.pollAttrs();
    this.emitState();
  }

  ntpFields(nowMs) {
    const zone = this.timezone();
    const offset = tz.offsetMinutes(zone, nowMs);
    const fields = { timezone: Math.round(offset / 60), timezoneOffsetSeconds: offset * 60 };
    const [next, second] = tz.nextTransitions(zone, nowMs, 2);
    if (next) {
      fields.nextDSTOffsetSeconds = next.offsetMinutes * 60;
      fields.nextDSTTransitionTs = next.atMs;
    }
    if (second) {
      fields.secondNextDSTOffsetSeconds = second.offsetMinutes * 60;
      fields.secondNextDSTTransitionTs = second.atMs;
    }
    return fields;
  }

  // The reply to the feeder's own time request. calibrationTag false tells it to
  // keep its clock, which is what we want when the clock is already close, or
  // when jumping it would skip or repeat a meal (the cloud-style behaviour
  // petlibro-local uses on this model).
  answerNtp(deviceTs) {
    const now = Date.now();
    let calibration = true;
    let followWithSync = false;
    if (typeof deviceTs === 'number' && deviceTs > 1e12) {
      const offset = Math.round((now - deviceTs) / 1000);
      this.clockOffsetS = offset;
      if (Math.abs(offset) <= CLOCK_TOLERANCE_S) {
        calibration = false;
      } else {
        const hold = this.clockHoldReason(offset, now);
        if (hold.reason) {
          calibration = false;
          log.info(this.name(), `time request ${offset} s off, keeping its clock: ${hold.reason}`);
        } else {
          followWithSync = true;
        }
      }
    }
    this.send('ntp', { cmd: 'NTP', code: 0, calibrationTag: calibration, ...this.ntpFields(now), ts: now });
    if (followWithSync) this.sendNtpSync();
  }

  // An unprompted time push, the way the real cloud corrects a One RFID. If
  // the feeder does not ack it, fall back to the plain NTP payload on
  // service/sub, which petlibro-local found it also applies.
  sendNtpSync() {
    const now = Date.now();
    const msgId = this.nextMsgId();
    this.ntpSyncPending.set(msgId, now);
    this.send('ntp', { cmd: 'NTP_SYNC', msgId, ...this.ntpFields(now), ts: now });
    setTimeout(() => {
      if (!this.ntpSyncPending.delete(msgId)) return;
      log.info(this.name(), 'no ack to NTP_SYNC, pushing the plain time answer instead');
      const t = Date.now();
      this.send('service', { cmd: 'NTP', code: 0, calibrationTag: true, ...this.ntpFields(t), ts: t });
    }, NTP_SYNC_ACK_TIMEOUT_MS).unref();
  }

  onNtpSyncAck(data) {
    this.ntpSyncPending.delete(data.msgId);
    if (typeof data.ts === 'number' && data.ts > 1e12) {
      this.clockOffsetS = Math.round((Date.now() - data.ts) / 1000);
      log.info(this.name(), `clock corrected, now ${this.clockOffsetS} s off`);
    }
  }

  // Why a clock jump must wait, or { reason: null } if it is safe. offset > 0
  // means the feeder is slow: jumping forward would skip any meal in between.
  // offset < 0 (fast): jumping back would serve a meal twice.
  clockHoldReason(offsetS, now) {
    const wire = this.persisted.wirePlans || [];
    const deviceNow = now - offsetS * 1000;
    const from = Math.min(now, deviceNow) - CLOCK_HOLD_SLACK_MS;
    const to = Math.max(now, deviceNow) + CLOCK_HOLD_SLACK_MS;
    const meals = plans.occurrences(wire, from, to);
    if (!meals.length) return { reason: null, meals };
    const when = meals.map((m) => tz.formatLocal(this.timezone(), m.at)).join(', ');
    return {
      reason: offsetS > 0
        ? `the ${when} meal falls inside the ${offsetS} s jump and would be skipped`
        : `the ${when} meal falls inside the ${-offsetS} s jump back and could be served twice`,
      meals,
    };
  }

  checkClock(deviceTs) {
    if (typeof deviceTs !== 'number' || deviceTs < 1e12) return;
    const now = Date.now();
    const offset = Math.round((now - deviceTs) / 1000);
    this.clockOffsetS = offset;
    const fix = this.clockFix;
    if (Math.abs(offset) <= CLOCK_TOLERANCE_S) {
      fix.tries = 0;
      fix.heldSince = null;
      return;
    }
    if (now < fix.backoffUntil || now - fix.lastPush < CLOCK_FIX_INTERVAL_MS) return;

    const hold = this.clockHoldReason(offset, now);
    let skipped = [];
    if (hold.reason) {
      if (fix.heldSince === null) fix.heldSince = now;
      // A slow clock cannot be held forever — every meal would keep running
      // late. After an hour, correct anyway and say which meal it cost.
      if (offset > 0 && now - fix.heldSince > CLOCK_SLOW_HOLD_MAX_MS) {
        skipped = hold.meals.filter((m) => m.at > now - offset * 1000 && m.at <= now);
      } else {
        if (now - fix.lastHoldLog >= 600000) {
          fix.lastHoldLog = now;
          log.info(this.name(), `clock ${offset} s off, holding the correction: ${hold.reason}`);
        }
        return;
      }
    } else {
      fix.heldSince = null;
    }

    if (fix.tries >= CLOCK_FIX_MAX_TRIES) {
      fix.tries = 0;
      fix.backoffUntil = now + CLOCK_FIX_BACKOFF_MS;
      log.warn(this.name(), `clock ${offset} s off and ${CLOCK_FIX_MAX_TRIES} corrections did not take, leaving it for an hour`);
      return;
    }
    fix.tries += 1;
    fix.lastPush = now;
    log.info(this.name(), `clock ${offset} s off, correcting (attempt ${fix.tries})`);
    this.sendNtpSync();
    for (const meal of skipped) {
      this.emitEvent('meal_skipped', { at: meal.at, reason: 'clock correction' });
    }
  }

  // --- feeding plans --------------------------------------------------------

  currentWire(now = Date.now()) {
    const sched = this.persisted.schedule;
    if (!sched || sched.paused) return [];
    const offset = tz.offsetMinutes(this.timezone(), now);
    return plans.toWire(sched.meals, offset, { callSound: sched.callSound !== false, syncTime: now });
  }

  // From Homey. Stored, converted and sent; re-sent until the feeder acks.
  setSchedule({ meals, timezone, callSound, paused }) {
    const validMeals = plans.validateMeals(meals);
    if (timezone !== undefined && !tz.isValidTimezone(timezone)) throw new Error(`unknown timezone "${timezone}"`);
    const prev = this.persisted.schedule || {};
    this.persisted.schedule = {
      meals: validMeals,
      timezone: timezone || prev.timezone || this.defaultTimezone,
      callSound: callSound === undefined ? prev.callSound !== false : Boolean(callSound),
      paused: paused === undefined ? Boolean(prev.paused) : Boolean(paused),
    };
    this.pushPlans('schedule changed');
  }

  setPaused(paused) {
    if (!this.persisted.schedule) throw new Error('no schedule set from Homey yet');
    this.persisted.schedule.paused = Boolean(paused);
    this.pushPlans(paused ? 'meals paused' : 'meals resumed');
  }

  pushPlans(why, { dstFrom = null } = {}) {
    const now = Date.now();
    let wire = this.currentWire(now);
    if (dstFrom) wire = plans.addDstSkips(dstFrom, wire, now);
    this.persisted.wirePlans = wire;
    this.persisted.wireOffset = tz.offsetMinutes(this.timezone(), now);
    this.persisted.planAcked = false;
    this.persisted.planSends = 0;
    this.store.save();
    log.info(this.name(), `${why}: sending ${wire.length} plan(s) ${JSON.stringify(wire.map((p) => `${p.executionTime}Z x${p.grainNum} [${p.repeatDay.join('')}]`))}`);
    this.sendPlans();
    this.emitState();
  }

  sendPlans() {
    const wire = plans.forWire(this.persisted.wirePlans || [], Date.now());
    this.persisted.planSends = (this.persisted.planSends || 0) + 1;
    this.persisted.planLastSend = Date.now();
    this.store.save();
    this.send('service', { cmd: 'FEEDING_PLAN_SERVICE', msgId: this.nextMsgId(), plans: wire });
  }

  // The feeder asks after every boot. Until Homey has sent a schedule the
  // bridge does not know the meals, and answers an empty list, which is what
  // petlibro-local does: the feeder then keeps running whatever plans it
  // already holds (reported, fw 3.0.72).
  answerPlanRequest() {
    const managed = Boolean(this.persisted.schedule);
    const wire = managed ? plans.forWire(this.persisted.wirePlans || this.currentWire(), Date.now()) : [];
    log.info(this.name(), managed
      ? `asked for its plans, answering ${wire.length}`
      : 'asked for its plans, none set from Homey yet — answering an empty list');
    this.send('event', { cmd: 'GET_FEEDING_PLAN_EVENT', code: 0, plans: wire });
  }

  onPlanAck(data) {
    if (data.code !== 0) {
      log.warn(this.name(), `refused the plans: code=${data.code}`);
      this.emitEvent('command_refused', { command: 'FEEDING_PLAN_SERVICE', code: data.code });
      return;
    }
    const expected = (this.persisted.wirePlans || []).map((p) => `${p.planId}/${p.syncTime}`);
    const received = new Set((Array.isArray(data.plans) ? data.plans : []).map((p) => `${p.planId}/${p.syncTime}`));
    // An empty list proves nothing — unless empty is exactly what was sent.
    if (expected.every((k) => received.has(k)) && (expected.length || !received.size)) {
      if (!this.persisted.planAcked) log.info(this.name(), 'plans acknowledged');
      this.persisted.planAcked = true;
      this.store.save();
      this.emitState();
    }
  }

  // Every minute: re-derive after a DST change, re-send what was not acked.
  reconcilePlans(now) {
    if (!this.persisted.schedule) return;
    const offset = tz.offsetMinutes(this.timezone(), now);
    if (typeof this.persisted.wireOffset === 'number' && offset !== this.persisted.wireOffset) {
      this.pushPlans(`UTC offset changed ${this.persisted.wireOffset} -> ${offset} min`, { dstFrom: this.persisted.wirePlans || [] });
      return;
    }
    if (this.persisted.planAcked || !this.online) return;
    if ((this.persisted.planSends || 0) >= PLAN_MAX_SENDS) return;
    if (now - (this.persisted.planLastSend || 0) >= PLAN_RESEND_MS) {
      log.info(this.name(), `plans not acknowledged yet, re-sending (${this.persisted.planSends} sent)`);
      this.sendPlans();
    }
  }

  // --- feeding / lid / pets -------------------------------------------------

  feed(portions) {
    const n = Number(portions);
    if (!Number.isInteger(n) || n < 1 || n > plans.MAX_PORTIONS) throw new Error(`portions must be 1..${plans.MAX_PORTIONS}`);
    if (!this.online) throw new Error('feeder offline');
    this.pendingManualFeed = Date.now();
    this.command({ cmd: 'MANUAL_FEEDING_SERVICE', grainNum: n });
    log.info(this.name(), `manual feed requested: ${n} portion(s)`);
  }

  onGrainOutput(data) {
    this.send('event', { cmd: 'GRAIN_OUTPUT_EVENT', msgId: data.msgId || '', code: 0, execStep: data.execStep || '' });
    if (!data.finished) return;
    const portions = Number(data.actualGrainNum) || 0;
    const manual = this.pendingManualFeed && Date.now() - this.pendingManualFeed <= MANUAL_FEED_WINDOW_MS;
    this.pendingManualFeed = 0;
    const source = manual ? 'manual' : 'scheduled';
    if (portions > 0) {
      this.persisted.lastFeed = { t: Date.now(), portions, source };
      this.store.save();
      this.emitEvent('fed', { portions, source });
    } else {
      // A finished dispense with nothing out: empty hopper or a jam, most
      // likely. Not documented — reported so it can be seen, not interpreted.
      this.emitEvent('feed_failed', { source, raw: { actualGrainNum: data.actualGrainNum, execStep: data.execStep } });
    }
    this.emitState();
  }

  setLid(open) {
    if (!this.online) throw new Error('feeder offline');
    this.command({ cmd: 'SWITCH_DOOR_SERVICE', barnDoorState: Boolean(open) });
    log.info(this.name(), `lid ${open ? 'open' : 'close'} requested`);
  }

  onLid(data) {
    if (typeof data.barnDoorState !== 'boolean') return;
    const was = this.attrs.barnDoorState;
    this.attrs.barnDoorState = data.barnDoorState;
    if (was !== data.barnDoorState) {
      this.emitEvent(data.barnDoorState ? 'lid_opened' : 'lid_closed', { trigger: data.triggerType || null });
    }
    if (!data.barnDoorState && this.persisted.lidJammed) this.clearJam();
    this.emitState();
  }

  onPetIdentify(data) {
    const tag = String(data.rfid || data.tagId || '');
    const type = String(data.type || '').toUpperCase();
    if (type === 'NEAR') {
      this.nearSince = { tag, t: Date.now() };
      this.emitEvent('pet_near', { rfid: tag });
    } else if (type === 'LEAVE') {
      const since = this.nearSince;
      this.nearSince = null;
      const seconds = since ? Math.round((Date.now() - since.t) / 1000) : null;
      this.persisted.lastVisit = { t: Date.now(), rfid: tag || (since && since.tag) || '', seconds };
      this.store.save();
      this.emitEvent('pet_left', { rfid: this.persisted.lastVisit.rfid, seconds });
      this.emitState();
    }
  }

  onError(data) {
    if (data.errorCode === ERROR_LID_JAMMED) {
      if (!this.persisted.lidJammed) {
        this.persisted.lidJammed = true;
        this.store.save();
        this.emitEvent('lid_jammed');
        this.emitState();
      }
      return;
    }
    this.emitEvent('device_error', { code: data.errorCode });
  }

  clearJam() {
    this.persisted.lidJammed = false;
    this.store.save();
    this.emitEvent('lid_unjammed');
  }

  // --- settings / display ---------------------------------------------------

  applySettings(changes) {
    if (!this.online) throw new Error('feeder offline');
    const sent = [];
    for (const [key, value] of Object.entries(changes || {})) {
      if (key === 'displayOn') {
        this.setDisplay(Boolean(value));
        sent.push(key);
        continue;
      }
      const spec = SETTING_FIELDS[key];
      if (!spec) throw new Error(`unknown setting "${key}"`);
      if (!spec.check(value)) throw new Error(`invalid value for ${key}: ${JSON.stringify(value)}`);
      this.command({ [spec.field]: value });
      this.attrs[spec.field] = value; // optimistic; the feeder confirms with an ATTR_PUSH_EVENT
      sent.push(key);
    }
    if (sent.length) log.info(this.name(), `settings sent: ${JSON.stringify(changes)}`);
    this.emitState();
  }

  // Mirrors the Petlibro app's own on/off message (petlibro-local capture):
  // the mode the feeder last reported, the fixed interval 2, and the sound
  // window length when it is known.
  setDisplay(on) {
    const aging = [1, 2].includes(this.attrs.screenDisplayAgingType) ? this.attrs.screenDisplayAgingType : 1;
    const body = { screenDisplaySwitch: on, screenDisplayAgingType: aging, screenDisplayInterval: 2 };
    if (typeof this.attrs.soundTimes === 'number') body.soundTimes = this.attrs.soundTimes;
    if (typeof this.attrs.audioUrl === 'string' && this.attrs.audioUrl) body.audioUrl = this.attrs.audioUrl;
    this.command(body);
    this.attrs.screenDisplaySwitch = on;
  }

  async showText(text) {
    if (!this.online) throw new Error('feeder offline');
    const { text: shown, frames } = textToFrames(text);
    if (!frames.length) throw new Error('nothing displayable in that text (A-Z, 0-9 and spaces only)');
    const chunks = [];
    for (let i = 0; i < frames.length; i += 20) chunks.push(frames.slice(i, i + 20));
    const msgId = this.nextMsgId();
    for (let i = 0; i < chunks.length; i += 1) {
      const body = {
        cmd: 'DISPLAY_MATRIX_SERVICE',
        msgId,
        screenDisplayMatrix: chunks[i],
        screenDisplayNumber: frames.length,
        screenDisplayId: 0,
        screenDisplayInterval: 2,
        displayScene: 'USER_CUSTOM',
        subNum: chunks.length,
        subIndex: i,
      };
      if (frames.length > 1) body.loopDisplay = true;
      this.send('service', body);
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 150));
    }
    this.persisted.displayText = shown;
    this.store.save();
    log.info(this.name(), `display text "${shown}" sent (${frames.length} frame(s))`);
    this.emitState();
    return shown;
  }
}

module.exports = { Feeder, MODEL };
