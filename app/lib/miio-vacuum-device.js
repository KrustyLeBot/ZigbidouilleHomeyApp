'use strict';

// Shared behaviour for every miIO robot vacuum in this app.
//
// It exists because the second robot (Vacuum 5) turned out to share ALL of the
// behaviour and NONE of the field numbers with the first (X20+): different
// status enum, different services, no equivalent of the X20+'s 4/7 pending
// task. Duplicating device.js would have meant every future fix landing in one
// copy and being forgotten in the other.
//
// So the model-specific part is a PROFILE (lib/x20plus.js, lib/vacuum5.js) and
// everything here is protocol logic that must behave identically on both.
// A profile supplies:
//
//   WATCHED           properties to poll, raw dids (see the note below)
//   ACTIONS           { clean, pause, home } as { siid, aiid }
//   FAULT             { siid, piid } read when confirming a stuck state
//   STATE_NAMES       state id -> human label
//   STATE_EVENT       state id -> timeline boolean capability
//   STUCK_STATES      states the robot cannot leave unaided
//   read(values)      raw poll -> { status, battery, charging, activity, cleanArea }
//   toState(...)      -> displayed state id
//   isActive(...)     -> a job is under way
//   isJobDone(...)    -> on the dock with nothing pending
//   isCleaning(...)   -> doing the actual cleaning work
//   isDrivingHome(...)-> returning, including a mid-clean mop-wash trip
//
// The hard-won rules in CLAUDE.md all live here, not in the profiles: no local
// state mirroring the robot, timeline booleans toggled rather than set in
// true/false pairs, stuck notifications evaluated every poll rather than on
// state change.

const Homey = require('homey');
const MiioClient = require('./miio-client');
const { Recorder } = require('./recorder');
const errlog = require('./errlog');

const DEFAULT_POLL_SECONDS = 10;
const FAILURES_BEFORE_UNAVAILABLE = 3; // the robot ignores reads while asleep
const FLUSH_INTERVAL = 60000; // batch store writes rather than one per poll
// The robot stops briefly by itself (~30s observed) and resumes unaided, so a
// stall must persist this long before it is worth notifying about.
const STUCK_CONFIRM_DELAY = 90000;

class MiioVacuumDevice extends Homey.Device {
  // Subclasses return their profile module. Declared as a getter rather than
  // passed in, so a driver is one small file with no wiring.
  get profile() {
    throw new Error('miio vacuum driver must define a profile');
  }

  async onInit() {
    this.failures = 0;
    this.lastStatus = null;
    this.lastState = null; // last displayed state, for timeline toggling
    this.cleanedThisCycle = false;

    // Devices paired before a capability was added keep their old capability
    // list (Homey caches it at pairing). Add any missing ones so new features
    // appear without the user having to remove and re-pair the device.
    await this.migrateCapabilities();

    // The recorder is told which fields to watch: the two robots have entirely
    // different field maps, and a recorder hardcoded to one of them would log
    // a column of empty cells for the other.
    this.recorder = new Recorder(this, this.profile.WATCHED);

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
      const values = await this.client.getProperties(this.profile.WATCHED);
      const reading = this.profile.read(values);
      if (reading.status === undefined) throw new Error('no status in reply');

      this.failures = 0;
      if (!this.getAvailable()) {
        // Pairs with the "unreachable" line below: an outage with no visible end
        // reads as still ongoing.
        this.note('reachable again', 'the robot answered');
        await this.setAvailable();
      }

      // Deliberately NOT mirrored into the verbose app log. A poll every 10 s
      // buries every other device's breadcrumbs within minutes, and it adds
      // nothing: the CSV below already holds the same values, deduplicated,
      // persisted and in a form that can be exported and diffed. The verbose
      // switch stays for the Zigbee drivers, where there is no such recorder.
      this.recorder.record(values);
      await this.update(reading);
    } catch (err) {
      this.failures += 1;
      // Not logged per failure either: an asleep robot fails on every poll and
      // would flood the log just as badly. Only the transition is news.
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE && this.getAvailable()) {
        this.note('unreachable', `no reply after ${this.failures} polls: ${err.message}`);
        await this.setUnavailable(this.homey.__('unreachable')).catch(() => {});
      }
    }
  }

  // Breadcrumb into the app log. Kept here rather than on the Zigbee base class
  // so both protocols log in the same `Device name: what happened` shape, which
  // is what the settings page's per-device filter reads.
  note(context, message) {
    this.log(context, message);
    errlog.info(`${this.getName()}: ${context}`, message);
  }

  async update({ status, battery, charging, activity, cleanArea, stationMode }) {
    const profile = this.profile;

    if (typeof battery === 'number') {
      await this.setCapabilityValue('measure_battery', battery).catch(() => {});
    }

    // Show the running area only while the robot is working; drop to 0 once it
    // is idle/docked, so the Insights graph shows a clear bump per clean rather
    // than holding the last total flat between runs.
    // A mid-clean recharge keeps reporting "paused" while on the dock, so it
    // stays "active" here and the area survives the charge as one bump.
    if (typeof cleanArea === 'number') {
      const area = profile.isActive(status, activity) ? cleanArea : 0;
      // Log write failures instead of swallowing them, so a broken capability
      // shows up in the app logs rather than a silent "-" on the tile.
      await this.setCapabilityValue('vacuum_clean_area', area).catch((err) => {
        this.error('set vacuum_clean_area', err);
        errlog.add(`set vacuum_clean_area=${area}`, err);
      });

      // Freeze last_cleaned_area on arrival at the dock, reading the area the
      // robot itself still reports. The counters survive the trip home, so there
      // is nothing to remember locally.
      // Freeze only when the job is really over (on the dock, nothing pending):
      // a mop wash docks mid-job with the task still set, and a mid-clean
      // recharge never reports the docked status at all. Neither lands here.
      if (profile.isJobDone(status, activity) && cleanArea > 0) {
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
    // Armed by any cleaning status - never a single value, since the mop
    // statuses are distinct - OR by a genuine return home: driving back with a
    // task still pending. That second case means an app restart during the
    // drive home still notifies, where "cleaning status only" would have missed
    // it. The area counter alone is not enough: it survives docking and never
    // resets, so a wandering robot still carries a stale area.
    // The third clause is the safety net, and it matters more than it looks:
    // on the Vacuum 5 the pending task clears while the robot is still DRIVING
    // home, so the second clause is false for the whole final leg and arming
    // rests entirely on recognising the cleaning status. A firmware reporting a
    // status the profile does not map — vacuum-only mode, say — would then
    // never arm, and the completion trigger would silently never fire.
    //
    // "A task is pending and the robot is off its dock" cannot be anything but
    // a job in progress, whatever number the status carries. It does not
    // re-introduce the night-wandering false positive either: the robot leaves
    // the dock with NO task pending on those trips.
    const returningFromJob = profile.isDrivingHome(status) && profile.hasPendingTask(activity);
    const workingOffDock = profile.hasPendingTask(activity) && !profile.isOnDock(status);
    if (profile.isCleaning(status) || returningFromJob || workingOffDock) {
      this.cleanedThisCycle = true;
    }

    const state = profile.toState(status, activity, charging);
    this.noteUnknownStatus(state, status, activity);
    await this.setCapabilityValue('vacuum_status', state).catch(() => {});

    // Toggle the timeline boolean ONLY when the displayed state actually changes.
    // Doing it every poll would spam the history with the same state on a loop.
    // Tracks state (not raw status): a pause can shift cleaning<->returning while
    // the raw status stays the same.
    const stateChanged = state !== this.lastState;
    this.lastState = state;
    if (stateChanged) await this.updateEventCapabilities(state);

    // Must run every poll - see the comment on the method.
    this.updateStuckNotification(state);

    // Checked on EVERY poll, before the "status changed" gate: on a profile
    // with a confirm delay this is a question of elapsed time, and gating it on
    // a transition would mean the deadline is only ever tested at the instant
    // the robot arrives — which is precisely when it cannot yet be answered.
    await this.checkCompletion(status, activity, stationMode);

    if (!changed || previous === null) return; // first poll: adopt without firing flows

    await this.fireTriggers(state);
  }

  // A clean is finished once the robot is back on the dock with no task left.
  // A mop wash cannot land here — it docks with the task still pending.
  //
  // Some robots cannot say that much at the dock: on the Vacuum 5 a finished
  // job and a mid-clean stop look identical on arrival. Such a profile supplies
  // isFinishing(), the robot's own end-of-job signal, and the completion waits
  // for it. A profile without one (the X20+, whose 4/7 is reliable) fires on
  // arrival exactly as before.
  //
  // The cleanedThisCycle guard stays either way: without it the robot's nightly
  // dock wandering (leaves and returns without cleaning) would fire every time.
  async checkCompletion(status, activity, stationMode) {
    const profile = this.profile;

    if (!this.cleanedThisCycle) return;
    if (!profile.isJobDone(status, activity)) return;
    if (profile.isFinishing && !profile.isFinishing(stationMode)) return;

    this.cleanedThisCycle = false;
    await this.toggleEvent('evt_completed');

    // Report the area that was frozen on arrival, not the live one —
    // vacuum_clean_area has already been forced to 0 by the time the robot
    // reads as docked.
    //
    // Failures are logged rather than swallowed: this used to end in a bare
    // .catch(this.error), so a rejected trigger left the timeline showing
    // "cleaning finished" while the flow card never ran, with nothing anywhere
    // to say why.
    try {
      await this.homey.flow.getDeviceTriggerCard('task_completed').trigger(this, {
        battery: this.getCapabilityValue('measure_battery') || 0,
        area: this.getCapabilityValue('last_cleaned_area') || 0,
      });
    } catch (err) {
      this.error('task_completed trigger', err);
      errlog.add(`${this.getName()}: task_completed trigger failed`, err);
    }
  }

  // A status the profile does not map collapses to 'unknown', and the raw value
  // that caused it would otherwise be lost — leaving "it went into some odd
  // state last night" with nothing to act on.
  //
  // Logged at INFO, not behind the verbose switch: this is the one thing worth
  // catching on an unattended overnight run, and it fires at most once per
  // distinct value per app start, so it cannot flood the log.
  noteUnknownStatus(state, status, activity) {
    if (state !== 'unknown') return;

    if (!this.unknownStatuses) this.unknownStatuses = new Set();
    if (this.unknownStatuses.has(status)) return;
    this.unknownStatuses.add(status);

    errlog.info(
      `${this.getName()}: unknown status`,
      `raw status=${status} task=${activity} — not in the profile's map, add it to lib/${this.driver.id}.js`,
    );
  }

  // One boolean per display state. Each is a momentary EVENT marker, not a
  // sustained state: entering a state pulses only that one boolean. The others
  // are left untouched, because setting a boolean back to false ALSO creates a
  // timeline entry - which was logging a phantom "started" event on every exit.
  async updateEventCapabilities(state) {
    const cap = this.profile.STATE_EVENT[state];
    // A state with no capability is silent rather than fatal: a firmware can
    // report a state the manifest does not model yet.
    if (cap && this.hasCapability(cap)) await this.toggleEvent(cap);
  }

  // The value is meaningless - it is just a marker - so flipping it is a single
  // change, and a single change is one timeline entry.
  async toggleEvent(cap) {
    const next = !this.getCapabilityValue(cap);
    await this.setCapabilityValue(cap, next).catch(() => {});
  }

  async fireTriggers(state) {
    const tokens = {
      status: this.profile.STATE_NAMES[state] || state,
      battery: this.getCapabilityValue('measure_battery') || 0,
    };

    await this.homey.flow
      .getDeviceTriggerCard('status_changed')
      .trigger(this, tokens)
      .catch(this.error);
  }

  // Runs on EVERY poll, not only on a state change: fireTriggers is gated on
  // "status changed", and a stall that started during a missed poll would then
  // never arm its timer and never notify.
  updateStuckNotification(state) {
    if (!this.profile.STUCK_STATES.includes(state)) {
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
        const { siid, piid } = this.profile.FAULT;
        const fresh = await this.client.getProperties([{ did: 'fault', siid, piid }]);
        fault = this.profile.readFault(fresh.fault);
      } catch (err) {
        // Unreachable robot: notify anyway, the stuck state itself is the news.
      }

      // Every stuck state counts as active, so vacuum_clean_area still holds
      // the live area rather than the forced 0 of an idle robot.
      const tokens = {
        status: this.profile.STATE_NAMES[state] || state,
        battery: this.getCapabilityValue('measure_battery') || 0,
        fault,
        area: this.getCapabilityValue('vacuum_clean_area') || 0,
      };
      this.homey.flow.getDeviceTriggerCard(state).trigger(this, tokens).catch(this.error);
    }, STUCK_CONFIRM_DELAY);
  }

  // --- actions ---

  async runAction(action) {
    await this.client.action(action.siid, action.aiid);
  }

  // Same MIoT action as resumeCleaning: from the dock it starts a new job,
  // from a paused clean it continues. Exposed separately so flows read clearly.
  async startCleaning() {
    await this.runAction(this.profile.ACTIONS.clean);
  }

  // Two explicit resume actions, deliberately: resuming a paused dock-return
  // with "resume cleaning" starts a full clean of the whole home. The user's
  // flow picks; the app never guesses.
  async resumeCleaning() {
    await this.runAction(this.profile.ACTIONS.clean);
  }

  async resumeReturning() {
    await this.runAction(this.profile.ACTIONS.home);
  }

  async pause() {
    await this.runAction(this.profile.ACTIONS.pause);
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

module.exports = MiioVacuumDevice;
