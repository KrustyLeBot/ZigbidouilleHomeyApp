'use strict';

// Petkit Pura Max 2 (T4) litter box, running our ESPHome firmware fork
// (KrustyLeBot/esphome-petkit-t4: Triskae's firmware + zigbidouille.yaml).
//
// The firmware is autonomous: cleaning, pet safety, identifying the two pets
// by weight and quiet hours all run on the box. This device only mirrors its
// state, sends commands, keeps the box's settings and Homey's in sync, and turns
// what happens into flow triggers — including ONE alert card carrying a
// ready-to-send message, so a single flow covers every alert.
//
// Talks to the firmware's web API (lib/esphome-web-client.js). Entities are
// addressed by their NAME in the firmware: renaming one there breaks it here.

const Homey = require('homey');
const errlog = require('./errlog');
const { EsphomeWebClient } = require('./esphome-web-client');

const OFFLINE_ALERT_DELAY = 5 * 60 * 1000;
// A persistent problem (full tray, motor fault) is announced once, then at most
// once a day while it lasts — reminders, not spam.
const REPEAT_PERSISTENT = 24 * 3600 * 1000;
const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

// Device setting key -> firmware entity (domain, name) and how to send it.
const SETTINGS = {
  pet1_name: { domain: 'text', name: 'Pet 1 Name' },
  pet1_min: { domain: 'number', name: 'Pet 1 Min Weight' },
  pet1_max: { domain: 'number', name: 'Pet 1 Max Weight' },
  pet2_name: { domain: 'text', name: 'Pet 2 Name' },
  pet2_min: { domain: 'number', name: 'Pet 2 Min Weight' },
  pet2_max: { domain: 'number', name: 'Pet 2 Max Weight' },
  clean_after: { domain: 'number', name: 'Clean After' },
  min_clean_interval: { domain: 'number', name: 'Min Clean Interval' },
  quiet_hours: { domain: 'switch', name: 'Quiet Hours' },
  quiet_start: { domain: 'text', name: 'Quiet Hours Start' },
  quiet_end: { domain: 'text', name: 'Quiet Hours End' },
  tray_capacity: { domain: 'number', name: 'Tray Capacity' },
};
const SETTING_BY_ENTITY = Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [`${v.domain}/${v.name}`, k]));
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

class PetkitT4Device extends Homey.Device {
  async onInit() {
    this.lastAlertAt = {};
    this.activeAlerts = new Set();
    this.offlineTimer = null;
    this.syncing = false;

    await this.migrateCapabilities();
    this.registerCapabilityListener('litter_auto_clean', (v) => this.setSwitch('Auto Clean', v));
    this.registerCapabilityListener('litter_block_movement', (v) => this.setSwitch('Block Movement', v));
    this.registerCapabilityListener('litter_clean_now', () => this.clean());
    this.registerCapabilityListener('litter_level_now', () => this.level());
    this.registerCapabilityListener('litter_bin_emptied', () => this.binEmptied());

    this.startClient();
    // Persistent alerts repeat daily while they last.
    this.repeatTimer = this.homey.setInterval(() => this.repeatPersistentAlerts(), 30 * 60 * 1000);
  }

  async migrateCapabilities() {
    const wanted = (this.driver.manifest && this.driver.manifest.capabilities) || [];
    for (const capability of wanted) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch((err) => errlog.add(`${this.getName()}: add ${capability}`, err));
      }
    }
  }

  note(context, message) {
    this.log(context, message);
    errlog.info(`${this.getName()}: ${context}`, message);
  }

  startClient() {
    if (this.client) this.client.stop();
    const s = this.getSettings();
    this.client = new EsphomeWebClient({
      host: s.address,
      username: s.username,
      password: s.password,
      onState: (id, value, state, previous) => this.onEntity(id, value, state, previous)
        .catch((err) => errlog.add(`${this.getName()}: ${id}`, err)),
      onConnected: () => this.onConnected(),
      onDisconnected: () => this.onDisconnected(),
      onError: (err) => errlog.add(`${this.getName()}: connection`, err),
    });
    this.client.start();
  }

  // --- connection ------------------------------------------------------------

  onConnected() {
    this.note('connected', `event stream open (${this.getSetting('address')})`);
    if (this.offlineTimer) this.homey.clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    this.setAvailable().catch(() => {});
    if (this.getCapabilityValue('alarm_offline')) {
      this.set('alarm_offline', false);
      this.clearAlert('offline', this.homey.__('petkit.alert.online'));
    }
  }

  onDisconnected() {
    if (this.offlineTimer) return;
    // Brief drops (a reboot, a firmware update) are normal: only a lasting
    // silence is an offline litter box worth telling anyone about.
    this.offlineTimer = this.homey.setTimeout(() => {
      this.offlineTimer = null;
      if (this.client && this.client.connected) return;
      this.set('alarm_offline', true);
      this.raiseAlert('offline', 'warning', 'connection', this.homey.__('petkit.alert.offline'), { persistent: false });
    }, OFFLINE_ALERT_DELAY);
  }

  // --- state from the box ------------------------------------------------------

  async set(capability, value) {
    if (value === undefined || value === null || !this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((err) => errlog.add(`${this.getName()}: set ${capability}`, err));
  }

  num(id) {
    const v = Number(this.client.value(id));
    return Number.isFinite(v) ? v : null;
  }

  bool(id) {
    const v = this.client.value(id);
    return typeof v === 'boolean' ? v : null;
  }

  text(id) {
    const v = this.client.value(id);
    return typeof v === 'string' ? v : null;
  }

  async onEntity(id, value, state, previous) {
    const was = previous ? previous.value : undefined;

    if (SETTING_BY_ENTITY[id]) await this.syncSetting(SETTING_BY_ENTITY[id], id);

    switch (id) {
      case 'switch/Auto Clean':
        await this.set('litter_auto_clean', Boolean(value));
        break;
      case 'switch/Block Movement':
        await this.set('litter_block_movement', Boolean(value));
        break;
      case 'switch/Clean':
        if (previous && was !== value) {
          await this.trigger(value ? 'petkit_cleaning_started' : 'petkit_cleaning_finished');
          errlog.debug(`${this.getName()}: cleaning`, value ? 'started' : 'finished');
        }
        break;
      case 'sensor/Waste Collected':
        await this.set('litter_waste', this.num(id));
        break;
      case 'binary_sensor/Tray Full':
        await this.set('alarm_litter_full', Boolean(value));
        if (value) this.raiseAlert('tray_full', 'warning', 'litter', this.homey.__('petkit.alert.tray_full'));
        else if (was) this.clearAlert('tray_full', this.homey.__('petkit.alert.tray_emptied'));
        break;
      case 'binary_sensor/Motor Error':
      case 'binary_sensor/MCU Link Lost':
        await this.updateFault(id, Boolean(value), Boolean(was));
        break;
      case 'sensor/Pet 1 Visits Today':
        await this.set('litter_pet1_visits', this.num(id));
        break;
      case 'sensor/Pet 2 Visits Today':
        await this.set('litter_pet2_visits', this.num(id));
        break;
      case 'text/Pet 1 Name':
      case 'text/Pet 2 Name':
        await this.renameVisitCounters();
        break;
      case 'sensor/Visit Count':
        // Visit Count is published last by the firmware: when it moves, the
        // last-visit fields already describe this visit.
        if (previous && Number(value) > Number(was)) await this.onVisit();
        break;
      default:
        break;
    }
    await this.updateStatus();
  }

  async updateFault(id, on, wasOn) {
    const motor = this.bool('binary_sensor/Motor Error');
    const link = this.bool('binary_sensor/MCU Link Lost');
    await this.set('alarm_litter_fault', Boolean(motor || link));
    const key = id === 'binary_sensor/Motor Error' ? 'motor_error' : 'link_lost';
    if (on) {
      const reason = key === 'motor_error' ? (this.text('text_sensor/Motor Error Reason') || '') : '';
      this.raiseAlert(key, 'critical', 'litter', this.homey.__(`petkit.alert.${key}`, { reason }));
    } else if (wasOn) {
      this.clearAlert(key, this.homey.__(`petkit.alert.${key}_cleared`));
    }
  }

  async updateStatus() {
    let status = 'idle';
    if (this.bool('binary_sensor/Motor Error') || this.bool('binary_sensor/MCU Link Lost')) status = 'error';
    else if (this.bool('switch/Block Movement')) status = 'blocked';
    else if (this.bool('switch/Maintenance')) status = 'maintenance';
    else if (this.bool('switch/Clean')) status = 'cleaning';
    else if (this.bool('binary_sensor/Pet Inside')) status = 'pet_inside';
    else if (this.bool('binary_sensor/In Quiet Hours') && this.bool('binary_sensor/Clean Pending')) status = 'quiet_hours';
    else if (this.bool('binary_sensor/Clean Pending')) status = 'clean_pending';
    await this.set('litter_status', status);
  }

  async renameVisitCounters() {
    for (const n of [1, 2]) {
      const name = this.text(`text/Pet ${n} Name`);
      if (!name) continue;
      await this.setCapabilityOptions(`litter_pet${n}_visits`, {
        title: { en: `${name} — visits today`, fr: `${name} — visites aujourd'hui` },
      }).catch(() => {});
    }
  }

  async onVisit() {
    const pet = this.text('text_sensor/Last Visit Pet') || 'Unknown';
    const weight = this.num('sensor/Last Visit Weight') || 0;
    const duration = this.num('sensor/Last Visit Duration') || 0;
    const known = pet !== 'Unknown';
    const label = known ? pet : this.homey.__('petkit.unknown_pet');
    const when = new Intl.DateTimeFormat(this.homey.i18n.getLanguage() === 'fr' ? 'fr-FR' : 'en-GB', {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit',
    }).format(new Date());
    await this.set('litter_last_visit', this.homey.__('petkit.last_visit', {
      pet: label, weight: weight.toFixed(2), minutes: Math.max(1, Math.round(duration / 60)), time: when,
    }));
    this.note('visit', `${label}, ${weight.toFixed(2)} kg, ${Math.round(duration)} s`);
    await this.trigger('petkit_pet_visit', { pet: label, weight, duration: Math.round(duration) });
    if (!known) {
      this.raiseAlert(`unknown_${Date.now()}`, 'info', 'pets',
        this.homey.__('petkit.alert.unknown_pet', { weight: weight.toFixed(2) }), { persistent: false });
    }
  }

  // --- the one alert card ------------------------------------------------------

  // `key` identifies the problem, so a persistent one is announced once (then
  // daily), and its end can be announced once too.
  raiseAlert(key, severity, category, message, { persistent = true } = {}) {
    const now = Date.now();
    if (persistent && this.activeAlerts.has(key)) return;
    if (persistent) this.activeAlerts.add(key);
    this.lastAlertAt[key] = now;
    this.lastAlertDetail = this.lastAlertDetail || {};
    this.lastAlertDetail[key] = { severity, category, message };
    this.note(`alert (${severity})`, message);
    this.trigger('petkit_alert', { message, severity, category, device: this.getName() }, { severity }).catch(() => {});
  }

  clearAlert(key, message) {
    const wasActive = this.activeAlerts.delete(key) || key === 'offline';
    if (!wasActive || !message) return;
    this.note('alert (info)', message);
    this.trigger('petkit_alert', { message, severity: 'info', category: 'recovery', device: this.getName() }, { severity: 'info' })
      .catch(() => {});
  }

  repeatPersistentAlerts() {
    const now = Date.now();
    for (const key of this.activeAlerts) {
      const detail = this.lastAlertDetail && this.lastAlertDetail[key];
      if (!detail || now - (this.lastAlertAt[key] || 0) < REPEAT_PERSISTENT) continue;
      this.lastAlertAt[key] = now;
      this.note(`alert (${detail.severity}, reminder)`, detail.message);
      this.trigger('petkit_alert', { ...detail, device: this.getName() }, { severity: detail.severity }).catch(() => {});
    }
  }

  async trigger(card, tokens = {}, state = {}) {
    await this.homey.flow.getDeviceTriggerCard(card).trigger(this, tokens, state).catch((err) => {
      this.error(card, err);
      errlog.add(`${this.getName()}: trigger ${card}`, err);
    });
  }

  static alertPasses(min, state) {
    return SEVERITY_RANK[state.severity] >= SEVERITY_RANK[min || 'info'];
  }

  // --- commands ------------------------------------------------------------------

  async setSwitch(name, on) {
    await this.client.command('switch', name, on ? 'turn_on' : 'turn_off');
    this.note('command', `${name} ${on ? 'on' : 'off'}`);
  }

  async clean() {
    await this.client.command('switch', 'Clean', 'turn_on');
    this.note('command', 'clean');
  }

  async level() {
    await this.client.command('button', 'Level', 'press');
    this.note('command', 'level');
  }

  async binEmptied() {
    await this.client.command('button', 'Bin Emptied', 'press');
    this.note('command', 'bin emptied');
  }

  // --- settings <-> box ------------------------------------------------------------

  // The box is the truth: whatever it holds (set here, on its own page, or
  // left from before) is copied into the device settings. setSettings does not
  // call onSettings, so this never echoes back.
  async syncSetting(key, id) {
    const spec = SETTINGS[key];
    let value = this.client.value(id);
    if (spec.domain === 'number') value = Number(value);
    if (spec.domain === 'switch') value = Boolean(value);
    if (spec.domain === 'number' && !Number.isFinite(value)) return;
    if (this.getSetting(key) === value) return;
    await this.setSettings({ [key]: value }).catch((err) => errlog.add(`${this.getName()}: sync ${key}`, err));
  }

  async onSettings({ newSettings, changedKeys }) {
    const connection = ['address', 'username', 'password'].some((k) => changedKeys.includes(k));
    for (const key of ['quiet_start', 'quiet_end']) {
      if (!changedKeys.includes(key)) continue;
      const m = TIME_RE.exec(String(newSettings[key]).trim());
      if (!m) throw new Error(this.homey.__('petkit.bad_time', { value: newSettings[key] }));
      newSettings[key] = `${m[1].padStart(2, '0')}:${m[2]}`;
    }
    for (const [a, b] of [['pet1_min', 'pet1_max'], ['pet2_min', 'pet2_max']]) {
      if (Number(newSettings[a]) >= Number(newSettings[b])) throw new Error(this.homey.__('petkit.bad_range'));
    }
    // Throwing refuses the save: a setting the box did not take must not look saved.
    for (const key of changedKeys) {
      const spec = SETTINGS[key];
      if (!spec) continue;
      const value = newSettings[key];
      if (spec.domain === 'switch') await this.client.command('switch', spec.name, value ? 'turn_on' : 'turn_off');
      else await this.client.command(spec.domain, spec.name, 'set', value);
    }
    if (connection) this.homey.setTimeout(() => this.startClient(), 500);
  }

  async onDeleted() {
    this.cleanup();
  }

  async onUninit() {
    this.cleanup();
  }

  cleanup() {
    if (this.client) this.client.stop();
    if (this.offlineTimer) this.homey.clearTimeout(this.offlineTimer);
    if (this.repeatTimer) this.homey.clearInterval(this.repeatTimer);
  }
}

module.exports = PetkitT4Device;
