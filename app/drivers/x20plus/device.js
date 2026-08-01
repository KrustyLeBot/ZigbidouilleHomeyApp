'use strict';

const Homey = require('homey');
const MiioClient = require('../../lib/miio-client');
const {
  ACTIONS,
  STATUS,
  CLEANING_STATUSES,
  ACTIVITY,
  STATE_NAMES,
  toState,
  isActive,
  isJobDone,
} = require('../../lib/x20plus');
const { Recorder, WATCHED } = require('../../lib/recorder');
const errlog = require('../../lib/errlog');

const DEFAULT_POLL_SECONDS = 10;
const FAILURES_BEFORE_UNAVAILABLE = 3; // the robot ignores reads while asleep
const FLUSH_INTERVAL = 60000; // batch store writes rather than one per poll
// The robot stops briefly by itself (~30s observed) and resumes unaided, so a
// stall must persist this long before it is worth notifying about.
const STUCK_CONFIRM_DELAY = 90000;

class X20PlusDevice extends Homey.Device {
  async onInit() {
    this.failures = 0;
    this.lastStatus = null;
    this.lastState = null; // last displayed state, for timeline toggling
    this.cleanedThisCycle = false;

    // Devices paired before a capability was added keep their old capability
    // list (Homey caches it at pairing). Add any missing ones so new features
    // appear without the user having to remove and re-pair the device.
    await this.migrateCapabilities();

    this.recorder = new Recorder(this);

    this.connect();
    this.poll();
    this.startPolling();
    this.flushTimer = this.homey.setInterval(() => this.recorder.flush(), FLUSH_INTERVAL);
  }

  async migrateCapabilities() {
    // The driver's manifest carries the up-to-date capability list from app.json;
    // an old paired device may be missing the newer ones. addCapability inherits
    // the capability definition (units/decimals) from the manifest.
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

    // Drop capabilities the manifest no longer declares. A device paired before
    // one was removed keeps it forever otherwise, and Homey then walks a
    // capability it has no definition for - which crashes the device page.
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

  startPolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    const seconds = Number(this.getSetting('poll_interval')) || DEFAULT_POLL_SECONDS;
    this.pollTimer = this.homey.setInterval(() => this.poll(), seconds * 1000);
  }

  connect() {
    if (this.client) this.client.destroy();
    const { address, token } = this.getSettings();
    this.client = new MiioClient(address, token);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('address') || changedKeys.includes('token')) {
      this.connect();
    }
    if (changedKeys.includes('poll_interval')) {
      // Settings are applied after this returns, so restart on the next tick.
      this.homey.setTimeout(() => this.startPolling(), 100);
    }
  }

  async poll() {
    try {
      // Reads the wide watched set: the extra fields cost nothing in one
      // batched call and are what the recorder needs to catch a recharge.
      const values = await this.client.getProperties(WATCHED);
      if (values.status === undefined) throw new Error('no status in reply');

      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();

      // Raw miIO values, behind the same "verbose logging" switch the Zigbee
      // drivers use. Off by default: this polls every 10 s and would bury the
      // log within minutes. The CSV recorder below keeps the full history
      // regardless — this is for watching the robot live.
      errlog.debug(`${this.getName()}: miio poll`, JSON.stringify(values));

      this.recorder.record(values);
      await this.update(values);
    } catch (err) {
      this.failures += 1;
      // A single timeout usually just means the robot is asleep.
      errlog.debug(`${this.getName()}: miio poll failed`, err.message);
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE && this.getAvailable()) {
        await this.setUnavailable(this.homey.__('unreachable')).catch(() => {});
      }
    }
  }

  async update(values) {
    // The poll uses the recorder's WATCHED set, whose fields carry raw dids.
    const status = values.status;
    const battery = values.battery;
    // siid 4 piid 7 = the pending task. Everything that has to tell "mid-job"
    // from "job over" reads it, because the mop cycle sends the robot home
    // mid-clean and the status alone then looks exactly like a finished job.
    const activity = values.s4p7;
    // siid 4 piid 3 = cleaned area in m2, verified against the Xiaomi app
    // (12 m2 there, 12 here). s4p1 is something else and stays near 0.
    const cleanArea = values.s4p3;

    if (typeof battery === 'number') {
      await this.setCapabilityValue('measure_battery', battery).catch(() => {});
    }

    // Show the running area only while the robot is working; drop to 0 once it
    // is idle/docked, so the Insights graph shows a clear bump per clean rather
    // than holding the last total flat between runs.
    // A mid-clean recharge keeps status 3 (PAUSED) while on the dock, so it
    // stays "active" here and the area survives the charge as one bump. The
    // freeze below is gated on status 6/13, which a recharge never reports.
    if (typeof cleanArea === 'number') {
      const area = isActive(status, activity) ? cleanArea : 0;
      // Log write failures instead of swallowing them, so a broken capability
      // shows up in the app logs rather than a silent "-" on the tile.
      await this.setCapabilityValue('vacuum_clean_area', area).catch((err) => {
        this.error('set vacuum_clean_area', err);
        errlog.add(`set vacuum_clean_area=${area}`, err);
      });

      // Freeze last_cleaned_area on arrival at the dock, reading the area the
      // robot itself still reports. The counters survive the trip home (4/3 held
      // 14 through an entire recharge), so there is nothing to remember locally.
      // Freeze only when the job is really over (on the dock, nothing pending).
      // Transient statuses like 0/2 also read as "not active" and would
      // otherwise freeze mid-clean; a mop wash docks mid-job with the task still
      // set; a mid-clean recharge reports 3, never 6/13. None of them land here.
      if (isJobDone(status, activity) && cleanArea > 0) {
        await this.setCapabilityValue('last_cleaned_area', cleanArea).catch((err) => {
          this.error('set last_cleaned_area', err);
          errlog.add(`set last_cleaned_area=${cleanArea}`, err);
        });
      }
    }

    const changed = status !== this.lastStatus;
    const previous = this.lastStatus;
    if (changed) this.lastStatus = status;

    // Track whether a real clean happened this cycle. The robot leaves the dock
    // and returns on its own (observed at night, battery full, never cleaning,
    // 10 times in one logged night), so "reached dock" alone is not completion.
    //
    // Armed by any cleaning status (1 vacuum, 12 vacuum+mop - the mop statuses
    // are why this must not test status 1 alone) OR by a genuine return home:
    // status 5/10 with a task still pending. A full-cycle log confirmed 4/7
    // reads 1 on every real return and 0 on every night wander (which never
    // cleaned), so the return case adds no false positives - and it means an app
    // restart during the drive home still notifies, where "cleaning status only"
    // would have missed it.
    // 4/3 alone is not enough: it survives docking (held 14 m2 through a whole
    // recharge) and never resets, so a wandering robot still carries stale area.
    const driving = status === STATUS.RETURNING || status === STATUS.RETURNING_WASH;
    const returningFromJob = driving && activity !== ACTIVITY.NONE;
    if (CLEANING_STATUSES.includes(status) || returningFromJob) {
      this.cleanedThisCycle = true;
    }

    const state = toState(status, activity, values.charging);
    await this.setCapabilityValue('vacuum_status', state).catch(() => {});

    // Toggle the timeline boolean ONLY when the displayed state actually changes.
    // Doing it every poll would spam the history with the same state on a loop.
    // Tracks state (not raw status): a pause can shift cleaning<->returning while
    // the raw status stays 3.
    const stateChanged = state !== this.lastState;
    this.lastState = state;
    if (stateChanged) await this.updateEventCapabilities(state);

    // Must run every poll - see the comment on the method.
    this.updateStuckNotification(state);

    if (!changed || previous === null) return; // first poll: adopt without firing flows

    await this.fireTriggers(state);

    // A clean is finished once the robot is back on the dock with no task left.
    // A mid-clean recharge cannot land here (it reports status 3 while charging)
    // and neither can a mop wash, which docks with the task still pending. Same
    // edge freezes last_cleaned_area above.
    // The cleanedThisCycle guard stays: without it the robot's nightly dock
    // wandering (leaves and returns without cleaning) would fire every time.
    if (isJobDone(status, activity) && this.cleanedThisCycle) {
      this.cleanedThisCycle = false;
      await this.toggleEvent('evt_completed');
      // Report the area that was just frozen, not the live one - vacuum_clean_area
      // has already been forced to 0 by the time the robot reads as docked.
      await this.homey.flow
        .getDeviceTriggerCard('task_completed')
        .trigger(this, {
          battery: this.getCapabilityValue('measure_battery') || 0,
          area: this.getCapabilityValue('last_cleaned_area') || 0,
        })
        .catch(this.error);
    }
  }

  // One boolean per display state. Each is a momentary EVENT marker, not a
  // sustained state: entering a state pulses only that one boolean. The others
  // are left untouched, because setting a boolean back to false ALSO creates a
  // timeline entry - which was logging a phantom "started" event on every exit.
  static STATE_EVENT = {
    cleaning: 'evt_cleaning',
    mopping: 'evt_mopping',
    recharging: 'evt_recharging',
    paused_cleaning: 'evt_paused_cleaning',
    returning: 'evt_returning',
    returning_wash: 'evt_returning_wash',
    paused_returning: 'evt_paused_returning',
    washing: 'evt_washing',
    drying: 'evt_drying',
    mapping: 'evt_mapping',
    charging: 'evt_charging',
    docked: 'evt_docked',
    station: 'evt_station',
    idle: 'evt_idle',
    error_returning: 'evt_error_returning',
    error: 'evt_error',
    unknown: 'evt_unknown',
  };

  // Toggle only the entered state's boolean. The value is meaningless - it is
  // just a marker - so flipping it (true<->false) is a single change, and a
  // single change is one timeline entry. The other booleans are never touched,
  // so no exit ever logs a phantom event.
  async updateEventCapabilities(state) {
    const cap = X20PlusDevice.STATE_EVENT[state];
    if (cap) await this.toggleEvent(cap);
  }

  async toggleEvent(cap) {
    const next = !this.getCapabilityValue(cap);
    await this.setCapabilityValue(cap, next).catch(() => {});
  }

  async fireTriggers(state) {
    const tokens = {
      status: STATE_NAMES[state] || state,
      battery: this.getCapabilityValue('measure_battery') || 0,
    };

    await this.homey.flow
      .getDeviceTriggerCard('status_changed')
      .trigger(this, tokens)
      .catch(this.error);

  }

  // States the robot cannot leave on its own, each with a trigger card of the
  // same name. Errors are included: an obstacle the robot clears by itself
  // within the confirm delay is not worth a notification either.
  static STUCK_STATES = ['paused_cleaning', 'paused_returning', 'error_returning', 'error'];

  // Runs on EVERY poll, not only on a state change: fireTriggers is gated on
  // "status changed", and a stall that started during a missed poll would then
  // never arm its timer and never notify.
  updateStuckNotification(state) {
    if (!X20PlusDevice.STUCK_STATES.includes(state)) {
      // Moving again: cancel a pending notification and re-arm for next time.
      if (this.stuckTimer) {
        this.homey.clearTimeout(this.stuckTimer);
        this.stuckTimer = null;
      }
      this.stuckNotified = false;
      return;
    }

    // Delay the notification: the robot stops briefly on its own (~30s when
    // knocked off its dock) and resumes unaided. stuckNotified keeps it to one
    // notification per episode, however many polls it spans.
    if (this.stuckTimer || this.stuckNotified) return;

    this.stuckTimer = this.homey.setTimeout(async () => {
      this.stuckTimer = null;
      // Re-check: only notify if still stuck in the same way. A robot that moved
      // from paused_cleaning to error meanwhile gets the error card on the next
      // poll instead, since stuckNotified is still false.
      if (this.getCapabilityValue('vacuum_status') !== state) return;
      this.stuckNotified = true;

      // Read the fault straight from the robot rather than reusing the value
      // seen when the timer was armed 90s ago - it may well have changed since.
      let fault = 0;
      try {
        const fresh = await this.client.getProperties([{ did: 'fault', siid: 2, piid: 2 }]);
        fault = fresh.fault || 0;
      } catch (err) {
        // Unreachable robot: notify anyway, the stuck state itself is the news.
      }

      // All four stuck states count as active, so vacuum_clean_area still holds
      // the live area rather than the forced 0 of an idle robot.
      const tokens = {
        status: STATE_NAMES[state] || state,
        battery: this.getCapabilityValue('measure_battery') || 0,
        fault,
        area: this.getCapabilityValue('vacuum_clean_area') || 0,
      };
      this.homey.flow.getDeviceTriggerCard(state).trigger(this, tokens).catch(this.error);
    }, STUCK_CONFIRM_DELAY);

    // No "cleaning complete" trigger: this firmware exposes no job-pending flag,
    // so a mid-clean recharge is indistinguishable from a finished job. Any such
    // trigger would fire falsely every time the robot tops up. See FINDINGS.md.
  }

  // --- actions ---

  async runAction(action) {
    await this.client.action(action.siid, action.aiid);
  }

  // Same MIoT action as resumeCleaning: from the dock it starts a new job,
  // from a paused clean it continues. Exposed separately so flows read clearly.
  async startCleaning() {
    await this.runAction(ACTIONS.clean);
  }

  async resumeCleaning() {
    await this.runAction(ACTIONS.clean);
  }

  async resumeReturning() {
    await this.runAction(ACTIONS.home);
  }

  async pause() {
    await this.runAction(ACTIONS.pause);
  }

  // --- log export (used by the app settings page) ---

  getLogCsv() {
    return this.recorder.toCsv();
  }

  getLogCount() {
    return this.recorder.count;
  }

  async clearLog() {
    await this.recorder.clear();
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    if (this.flushTimer) this.homey.clearInterval(this.flushTimer);
    if (this.stuckTimer) this.homey.clearTimeout(this.stuckTimer);
    await this.recorder.flush();
    if (this.client) this.client.destroy();
  }
}

module.exports = X20PlusDevice;
