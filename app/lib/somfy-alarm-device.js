'use strict';

// The Somfy Protect alarm. Displays state and fires flow triggers on change,
// AND can arm/disarm/switch to night mode — both from the device tile's
// standard alarm-panel widget (homealarm_state is setable) and from a flow
// action card (somfy_set_state in app.json). See lib/somfy-client.js for the
// API this rides on: it is unofficial and reverse-engineered, so a write here
// is only ever sent through the Guest-role secondary account configured in
// Settings → Somfy — never the primary login, and Guest cannot touch site
// config or users even if the credentials leaked.
//
// Unlike the Imou cameras, this device does NOT depend on polling to notice a
// change: Somfy pushes `security.level.change` and the alarm.* events over a
// websocket (lib/somfy-events.js), so arming from the phone app — or from this
// app itself — reaches Homey in about a second. The poll below is a slow
// safety net, not the mechanism — it re-reads the truth in case the socket
// dropped a message or was down during a change, which a purely event-driven
// design would never notice.

const Homey = require('homey');
const errlog = require('./errlog');
const { getClient } = require('./somfy-account');
const { subscribe, unsubscribe, isConnected } = require('./somfy-events');

// Slow on purpose. With the websocket carrying every real change, polling more
// often buys nothing and just leans on someone else's unofficial API — and the
// one rate limit the reference projects actually document is on the token
// endpoint, which a needless reconnect/refresh cycle is exactly what would
// hit. 15 minutes is a resync, not a refresh rate.
const DEFAULT_POLL_SECONDS = 900;
const FAILURES_BEFORE_UNAVAILABLE = 3;

// Somfy's security_level -> Homey's standard homealarm_state enum. Different
// strings for the same three states (confirmed live 2026-08-08: Somfy's
// 'partial' is Homey's 'partially_armed', by activating night mode and
// reading the change). 'armed' is Somfy's own documented value, not yet
// separately observed live.
const STATE_MAP = {
  disarmed: 'disarmed',
  armed: 'armed',
  partial: 'partially_armed',
};

// The other direction, for writes: Homey's enum value -> Somfy's raw level.
const REVERSE_STATE_MAP = {
  disarmed: 'disarmed',
  armed: 'armed',
  partially_armed: 'partial',
};

// capability -> trigger card id, fired only on an actual change (see
// applyState below) — the same "toggle on entry, not every poll" discipline
// as everywhere else state changes are logged in this app.
const STATE_TRIGGERS = {
  armed: 'somfy_armed',
  disarmed: 'somfy_disarmed',
  partially_armed: 'somfy_night',
};

class SomfyAlarmDevice extends Homey.Device {
  async onInit() {
    this.failures = 0;
    this.lastState = undefined;
    this.lastTriggered = undefined;

    // Bound once so unsubscribe() can remove this exact function on delete.
    this.onEvent = (event) => this.handleEvent(event);
    subscribe(this.homey, this.siteId(), this.onEvent);

    // The tile's alarm-panel widget calls this the same way a flow action
    // does (setSecurityLevel below) — one code path for both.
    this.registerCapabilityListener('homealarm_state', (value) => this.setSecurityLevel(value));

    this.poll();
    this.startPolling();
  }

  // A pushed event from lib/somfy-events.js. Goes through the same apply*
  // methods as the poll, so triggers, logging and the "only on real change"
  // rule behave identically whichever path delivered the news.
  async handleEvent(event) {
    if (event.type === 'security_level') {
      await this.applyState(event.level);
    } else if (event.type === 'alarm') {
      await this.applyTriggered(event.triggered);
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
    if (!api) throw new Error(this.homey.__('somfy.not_configured'));
    return api;
  }

  siteId() {
    return this.getData().id;
  }

  note(context, message) {
    this.log(context, message);
    errlog.info(`${this.getName()}: ${context}`, message);
  }

  // Called by both the tile's alarm-panel widget (registerCapabilityListener
  // above) and the somfy_set_state flow action — same as every other
  // manual-vs-flow write in this app, one path either way.
  async setSecurityLevel(state) {
    const level = REVERSE_STATE_MAP[state];
    if (!level) throw new Error(`unsupported homealarm_state "${state}"`);

    const api = this.client();
    await api.setSecurityLevel(this.siteId(), level);
    this.note('security level set', `requested "${state}" (raw="${level}")`);

    // Optimistic: applyState only writes/triggers on an actual change, so if
    // the websocket's confirmation (usually ~1s later) already landed first
    // this is a no-op. Done so the tile does not lag a full 900s poll behind
    // a write that plainly succeeded.
    await this.applyState(level);
  }

  async poll() {
    try {
      const api = this.client();
      const site = await api.getSite(this.siteId());

      // security_level is confirmed ground truth (see docs/fingerprints.md),
      // so the poll always resyncs it.
      await this.applyState(site.security_level);

      // alarm_generic is NOT the same story. The websocket's alarm.trespass /
      // alarm.panic / alarm.end keys are named unambiguously, but this REST
      // field's semantics are a guess — `alarm.status` has only ever been
      // observed as "none", never during a real siren. So while the live
      // stream is up it is the authority and the poll keeps its hands off:
      // otherwise a genuine alarm raised by an event would be silently
      // cleared by the next poll 15 minutes later, firing a false
      // "alarm stopped" trigger while the siren is still going — the worst
      // possible moment to be wrong. Only when the stream is down does this
      // fall back to the guess, which is better than knowing nothing.
      if (!isConnected()) {
        await this.applyTriggered(Boolean(site.alarm && site.alarm.status && site.alarm.status !== 'none'));
      }

      this.failures = 0;
      if (!this.getAvailable()) {
        this.note('reachable again', 'the Somfy cloud answered');
        await this.setAvailable();
      }
    } catch (err) {
      this.failures += 1;
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE && this.getAvailable()) {
        this.note('unreachable', `no reply after ${this.failures} polls: ${err.message}`);
        await this.setUnavailable(this.homey.__('somfy.unreachable')).catch(() => {});
      }
      // Any real failure (rate limit, 5xx, auth) is already logged by
      // lib/somfy-account.js's onError hook — nothing more to add here.
    }
  }

  async applyState(rawLevel) {
    const state = STATE_MAP[rawLevel];
    if (!state) {
      // An unmapped value is worth knowing about without guessing at it —
      // logged once, capability left at its last known value rather than
      // written as something invented.
      if (rawLevel !== this.lastUnknownLevel) {
        this.lastUnknownLevel = rawLevel;
        errlog.info(`${this.getName()}: unknown security_level`,
          `raw="${rawLevel}" — not in STATE_MAP, add it to lib/somfy-alarm-device.js`);
      }
      return;
    }

    await this.setCapabilityValue('homealarm_state', state).catch((err) => {
      this.error('set homealarm_state', err);
      errlog.add('set homealarm_state', err);
    });

    const previous = this.lastState;
    this.lastState = state;
    if (previous === undefined || previous === state) return; // first poll or no change

    this.note('state changed', `${previous} -> ${state}`);

    const card = STATE_TRIGGERS[state];
    if (card) {
      await this.homey.flow.getDeviceTriggerCard(card).trigger(this, {}, {}).catch(this.error);
    }
    await this.homey.flow
      .getDeviceTriggerCard('somfy_state_changed')
      .trigger(this, { state }, {})
      .catch(this.error);
  }

  async applyTriggered(triggered) {
    await this.setCapabilityValue('alarm_generic', triggered).catch((err) => {
      this.error('set alarm_generic', err);
      errlog.add('set alarm_generic', err);
    });

    const previous = this.lastTriggered;
    this.lastTriggered = triggered;
    if (previous === undefined || previous === triggered) return;

    this.note(triggered ? 'alarm triggered' : 'alarm cleared', '');
    await this.homey.flow
      .getDeviceTriggerCard(triggered ? 'somfy_alarm_triggered' : 'somfy_alarm_cleared')
      .trigger(this, {}, {})
      .catch(this.error);
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    unsubscribe(this.siteId(), this.onEvent);
  }
}

module.exports = SomfyAlarmDevice;
