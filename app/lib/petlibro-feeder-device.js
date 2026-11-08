'use strict';

// Petlibro One RFID Smart Feeder (PLAF301), through petlibro-bridge.
//
// Nothing here speaks the feeder's protocol: lib/petlibro-bridge.js talks to
// the bridge, which talks MQTT to the feeder and plays the Petlibro cloud's
// part (see bridge/petlibro). This device turns the bridge's snapshots into
// capabilities, its events into flow triggers, and the device settings into
// the meal schedule and feeder settings.
//
// The schedule is edited in the device settings, in LOCAL time, and sent with
// Homey's own timezone (this.homey.clock.getTimezone(), never the process's —
// see CLAUDE.md on Date's local getters). The bridge stores it, converts it to
// the UTC the feeder runs, and re-converts at every DST change. While no meal
// has ever been saved here, the feeder keeps the plans it already had.

const Homey = require('homey');
const errlog = require('./errlog');
const bridge = require('./petlibro-bridge');

const MEAL_SLOTS = 6;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAY_PRESETS = {
  daily: [1, 2, 3, 4, 5, 6, 7],
  weekdays: [1, 2, 3, 4, 5],
  weekend: [6, 7],
  mon: [1],
  tue: [2],
  wed: [3],
  thu: [4],
  fri: [5],
  sat: [6],
  sun: [7],
};

// Device setting key -> bridge setting key, for the values the feeder itself
// reports back (so the settings page shows what the feeder really holds).
const FEEDER_SETTINGS = {
  lid_close_delay: 'lidCloseDelay',
  lid_close_speed: 'lidCloseSpeed',
  sound: 'sound',
  volume: 'volume',
  child_lock: 'childLock',
  display_on: 'displayOn',
};

// Bridge event -> flow trigger card. Fired as the bridge reports them: the
// bridge already only emits on an actual change.
const EVENT_TRIGGERS = {
  fed: 'petlibro_fed',
  feed_failed: 'petlibro_feed_failed',
  pet_left: 'petlibro_pet_visit',
  food_low: 'petlibro_food_low',
  food_refilled: 'petlibro_food_refilled',
  on_battery: 'petlibro_on_battery',
  mains_restored: 'petlibro_mains_restored',
  lid_jammed: 'petlibro_lid_jammed',
  offline: 'petlibro_offline',
  online: 'petlibro_online',
  meal_skipped: 'petlibro_meal_skipped',
  device_error: 'petlibro_device_error',
  outlet_blocked: 'petlibro_outlet_blocked',
  outlet_cleared: 'petlibro_outlet_cleared',
  refill_due: 'petlibro_refill_due',
};

// Device setting key -> bridge refill-reminder key.
const REFILL_SETTINGS = {
  refill_enabled: 'enabled',
  refill_interval_days: 'intervalDays',
  refill_time: 'time',
};

class PetlibroFeederDevice extends Homey.Device {
  async onInit() {
    this.lastBattery = null;
    this.syncedFeederSettings = {};
    this.scheduleSignature = null;
    this.customDays = {}; // slot -> days the bridge holds that no dropdown preset matches

    await this.migrateCapabilities();

    this.registerCapabilityListener('feeder_lid_open', (value) => this.setLid(value));
    this.registerCapabilityListener('feeder_lid_mode', (value) => this.setLidMode(value));
    this.registerCapabilityListener('feeder_meals_paused', (value) => this.setMealsPaused(value));
    this.registerCapabilityListener('feeder_mark_refilled', () => this.markRefilled());

    this.onMessage = (message) => this.handleMessage(message).catch((err) => errlog.add(`${this.getName()}: update`, err));
    bridge.subscribe(this.homey, this.serial(), this.onMessage);
    if (!bridge.isConfigured(this.homey)) {
      await this.setUnavailable(this.homey.__('petlibro.not_configured')).catch(() => {});
    }
  }

  serial() {
    return this.getData().id;
  }

  note(context, message) {
    this.log(context, message);
    errlog.info(`${this.getName()}: ${context}`, message);
  }

  // Devices paired before a capability existed get it added here, so a new
  // capability does not need a re-pair (same idea as lib/zigbee-device.js).
  async migrateCapabilities() {
    const wanted = (this.driver.manifest && this.driver.manifest.capabilities) || [];
    for (const capability of wanted) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch((err) => errlog.add(`${this.getName()}: add ${capability}`, err));
      }
    }
  }

  // --- incoming ---------------------------------------------------------------

  async handleMessage(message) {
    if (message.type === 'bridge') {
      if (message.connected) await this.setAvailable().catch(() => {});
      else await this.setUnavailable(this.homey.__('petlibro.bridge_unreachable')).catch(() => {});
      return;
    }
    if (message.type === 'state') {
      if (!this.getAvailable()) await this.setAvailable().catch(() => {});
      await this.applyState(message.feeder);
      return;
    }
    if (message.type === 'event') await this.applyEvent(message.event);
  }

  async set(capability, value) {
    if (value === null || value === undefined || !this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((err) => errlog.add(`${this.getName()}: set ${capability}`, err));
  }

  async applyState(f) {
    await this.set('alarm_offline', !f.online);
    await this.set('measure_battery', f.battery);
    await this.set('feeder_power', f.power);
    await this.set('alarm_food_low', f.foodLow);
    await this.set('feeder_lid_open', f.lidOpen);
    await this.set('alarm_lid_jammed', f.lidJammed);
    await this.set('alarm_outlet_blocked', f.outletBlocked);
    if (f.refill) await this.set('alarm_refill_due', f.refill.due);
    if (f.settings) await this.set('feeder_lid_mode', f.settings.lidMode);
    await this.set('feeder_meals_paused', f.schedule ? f.schedule.paused : false);
    if (f.lastFeed) await this.set('feeder_last_feed', this.describeFeed(f.lastFeed));

    await this.checkBattery(f.battery);
    await this.syncSettingsFromFeeder(f);
  }

  async checkBattery(battery) {
    if (typeof battery !== 'number') return;
    const threshold = Number(this.getSetting('battery_low_threshold')) || 0;
    const previous = this.lastBattery;
    this.lastBattery = battery;
    if (!threshold || previous === null) return;
    if (previous > threshold && battery <= threshold) {
      this.note('battery low', `${battery} % (threshold ${threshold} %)`);
      await this.trigger('petlibro_battery_low', { battery });
    }
  }

  // Settings the feeder reports are copied into the device settings, so the
  // page shows the feeder's truth — including changes made on the feeder
  // itself. setSettings does not call onSettings, so this never echoes back.
  async syncSettingsFromFeeder(f) {
    const changes = {};
    for (const [key, bridgeKey] of Object.entries(FEEDER_SETTINGS)) {
      const value = f.settings ? f.settings[bridgeKey] : null;
      if (value === null || value === undefined) continue;
      if (this.syncedFeederSettings[key] === value) continue;
      this.syncedFeederSettings[key] = value;
      if (this.getSetting(key) !== value) changes[key] = value;
    }
    if (f.refill) {
      for (const [key, bridgeKey] of Object.entries(REFILL_SETTINGS)) {
        const value = f.refill[bridgeKey];
        if (value === undefined || this.syncedFeederSettings[key] === value) continue;
        this.syncedFeederSettings[key] = value;
        if (this.getSetting(key) !== value) changes[key] = value;
      }
    }
    if (f.settings && f.settings.displayText && this.getSetting('display_text') !== f.settings.displayText
      && this.syncedFeederSettings.display_text !== f.settings.displayText) {
      this.syncedFeederSettings.display_text = f.settings.displayText;
      changes.display_text = f.settings.displayText;
    }
    // The schedule can also be edited on the bridge's own web page: whenever
    // the bridge's copy changes, the meal slots follow, so the two never drift
    // and a later save from Homey cannot resurrect an old version.
    const signature = f.schedule ? JSON.stringify([f.schedule.meals, f.schedule.callSound]) : null;
    if (signature && signature !== this.scheduleSignature) {
      this.scheduleSignature = signature;
      for (const [key, value] of Object.entries(this.mealsToSettings(f.schedule))) {
        if (this.getSetting(key) !== value) changes[key] = value;
      }
    }
    if (Object.keys(changes).length) {
      await this.setSettings(changes).catch((err) => errlog.add(`${this.getName()}: sync settings`, err));
    }
  }

  // The schedule the bridge holds, written back into the meal slots: covers a
  // re-paired device, or a second Homey reading the same bridge.
  mealsToSettings(schedule) {
    const out = { meal_call_sound: schedule.callSound !== false };
    const meals = schedule.meals || [];
    for (let i = 1; i <= MEAL_SLOTS; i += 1) {
      const meal = meals[i - 1];
      out[`meal${i}_time`] = meal && meal.enabled !== false ? meal.time : '';
      if (!meal) continue;
      out[`meal${i}_portions`] = meal.portions;
      const preset = Object.keys(DAY_PRESETS).find((k) => DAY_PRESETS[k].join() === meal.days.join());
      if (preset) {
        out[`meal${i}_days`] = preset;
        delete this.customDays[i];
      } else {
        // Days picked on the bridge page that no dropdown entry matches: kept
        // as they are, shown as "custom", and sent back unchanged on a save.
        out[`meal${i}_days`] = 'custom';
        this.customDays[i] = meal.days;
      }
    }
    return out;
  }

  describeFeed(feed) {
    const time = new Intl.DateTimeFormat(this.homey.i18n.getLanguage() === 'fr' ? 'fr-FR' : 'en-GB', {
      timeZone: this.homey.clock.getTimezone(), weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(feed.t));
    const source = this.homey.__(`petlibro.source_${feed.source}`);
    return this.homey.__('petlibro.last_feed', { time, portions: feed.portions, source });
  }

  async applyEvent(event) {
    const card = EVENT_TRIGGERS[event.type];
    if (!card) return;
    const tokens = {};
    if (event.type === 'fed') {
      tokens.portions = event.portions;
      tokens.source = this.homey.__(`petlibro.source_${event.source}`);
    } else if (event.type === 'feed_failed') {
      tokens.source = this.homey.__(`petlibro.source_${event.source}`);
    } else if (event.type === 'pet_left') {
      tokens.tag = event.rfid || '';
      tokens.seconds = event.seconds || 0;
    } else if (event.type === 'meal_skipped') {
      tokens.time = new Intl.DateTimeFormat('en-GB', {
        timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit',
      }).format(new Date(event.at));
    } else if (event.type === 'refill_due') {
      tokens.days = Number(event.days) || 0;
    } else if (event.type === 'device_error') {
      tokens.code = Number(event.code) || 0;
    }
    if (['feed_failed', 'meal_skipped', 'device_error', 'lid_jammed', 'on_battery', 'outlet_blocked', 'refill_due'].includes(event.type)) {
      this.note(event.type, JSON.stringify(event));
    } else {
      errlog.debug(`${this.getName()}: ${event.type}`, JSON.stringify(event));
    }
    await this.trigger(card, tokens);
  }

  async trigger(card, tokens = {}) {
    await this.homey.flow.getDeviceTriggerCard(card).trigger(this, tokens, {}).catch((err) => {
      this.error(card, err);
      errlog.add(`${this.getName()}: trigger ${card}`, err);
    });
  }

  // --- commands (tile, flow cards and settings share these) ---------------

  path(suffix = '') {
    return `/api/feeders/${encodeURIComponent(this.serial())}${suffix}`;
  }

  async feed(portions) {
    await bridge.request(this.homey, 'POST', this.path('/feed'), { portions: Number(portions) });
    this.note('feed', `${portions} portion(s) requested`);
  }

  async setLid(open) {
    await bridge.request(this.homey, 'POST', this.path('/lid'), { open: Boolean(open) });
    this.note('lid', open ? 'open requested' : 'close requested');
  }

  async setLidMode(mode) {
    await bridge.request(this.homey, 'POST', this.path('/settings'), { lidMode: mode });
    this.note('lid mode', mode);
  }

  async setMealsPaused(paused) {
    await bridge.request(this.homey, 'POST', this.path('/schedule/paused'), { paused: Boolean(paused) });
    this.note('meals', paused ? 'paused' : 'resumed');
  }

  async markRefilled() {
    await bridge.request(this.homey, 'POST', this.path('/refill'));
    this.note('refill', 'hopper marked as refilled');
  }

  async showText(text) {
    const result = await bridge.request(this.homey, 'POST', this.path('/display'), { text: String(text || '') });
    this.syncedFeederSettings.display_text = result.text;
    if (this.getSetting('display_text') !== result.text) await this.setSettings({ display_text: result.text }).catch(() => {});
    this.note('display', `"${result.text}"`);
  }

  // --- settings -> feeder ------------------------------------------------------

  mealsFromSettings(settings) {
    const meals = [];
    for (let i = 1; i <= MEAL_SLOTS; i += 1) {
      const raw = String(settings[`meal${i}_time`] || '').trim();
      if (!raw) continue;
      const m = TIME_RE.exec(raw);
      if (!m) throw new Error(this.homey.__('petlibro.bad_time', { slot: i, value: raw }));
      meals.push({
        time: `${m[1].padStart(2, '0')}:${m[2]}`,
        days: settings[`meal${i}_days`] === 'custom'
          ? (this.customDays[i] || DAY_PRESETS.daily)
          : DAY_PRESETS[settings[`meal${i}_days`]] || DAY_PRESETS.daily,
        portions: Number(settings[`meal${i}_portions`]) || 1,
      });
    }
    return meals;
  }

  async onSettings({ newSettings, changedKeys }) {
    // Throwing here refuses the save and shows the message: a schedule the
    // bridge did not accept must not look saved.
    const mealKeys = changedKeys.filter((k) => /^meal/.test(k));
    if (mealKeys.length) {
      const meals = this.mealsFromSettings(newSettings);
      await bridge.request(this.homey, 'PUT', this.path('/schedule'), {
        meals,
        timezone: this.homey.clock.getTimezone(),
        callSound: Boolean(newSettings.meal_call_sound),
      });
      this.note('schedule', meals.length
        ? meals.map((m) => `${m.time} x${m.portions} [${m.days.join('')}]`).join(', ')
        : 'no meal — the feeder plans were cleared');
    }

    const feederChanges = {};
    for (const [key, bridgeKey] of Object.entries(FEEDER_SETTINGS)) {
      if (!changedKeys.includes(key)) continue;
      feederChanges[bridgeKey] = key === 'volume' || key === 'lid_close_delay' ? Number(newSettings[key]) : newSettings[key];
      this.syncedFeederSettings[key] = newSettings[key];
    }
    if (Object.keys(feederChanges).length) {
      await bridge.request(this.homey, 'POST', this.path('/settings'), feederChanges);
    }

    const refillChanges = {};
    for (const [key, bridgeKey] of Object.entries(REFILL_SETTINGS)) {
      if (!changedKeys.includes(key)) continue;
      refillChanges[bridgeKey] = key === 'refill_interval_days' ? Number(newSettings[key]) : newSettings[key];
      this.syncedFeederSettings[key] = refillChanges[bridgeKey];
    }
    if (Object.keys(refillChanges).length) {
      if (refillChanges.time !== undefined) {
        const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(refillChanges.time).trim());
        if (!m) throw new Error(this.homey.__('petlibro.bad_refill_time', { value: refillChanges.time }));
        refillChanges.time = `${m[1].padStart(2, '0')}:${m[2]}`;
      }
      await bridge.request(this.homey, 'PUT', this.path('/refill-reminder'), refillChanges);
    }

    if (changedKeys.includes('display_text') && String(newSettings.display_text || '').trim()) {
      // Sent after this save completes: showText writes the normalised text
      // back into the settings, which is not allowed from inside onSettings.
      const text = newSettings.display_text;
      this.homey.setTimeout(() => this.showText(text).catch((err) => errlog.add(`${this.getName()}: display`, err)), 500);
    }
  }

  async onDeleted() {
    bridge.unsubscribe(this.serial(), this.onMessage);
  }

  async onUninit() {
    bridge.unsubscribe(this.serial(), this.onMessage);
  }
}

module.exports = PetlibroFeederDevice;
