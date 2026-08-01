'use strict';

// Endpoints backing the settings page, so recent errors can be inspected from
// Homey without the CLI.

const errlog = require('./lib/errlog');

// The vacuum driver may not exist yet (or at all) on a given install, so this
// never throws — the settings page just shows an empty raw log.
function vacuums(homey) {
  try {
    return homey.drivers.getDriver('x20plus').getDevices();
  } catch (err) {
    return [];
  }
}

module.exports = {
  // Merges the in-memory ring with what is persisted in settings. Reading both
  // is deliberate belt-and-braces: it also covers entries written before the
  // log was initialised, and any case where this module does not share state
  // with the running app instance.
  async getErrors({ homey }) {
    const live = errlog.list();
    let stored = [];
    try {
      const raw = homey.settings.get('log');
      if (Array.isArray(raw)) stored = raw;
    } catch (err) {
      // fall through to whatever is in memory
    }

    const seen = new Set(live.map((e) => `${e.t}|${e.context}`));
    const merged = live.concat(stored.filter((e) => !seen.has(`${e.t}|${e.context}`)));
    merged.sort((a, b) => b.t - a.t);
    return { entries: merged.slice(0, 200) };
  },

  async clearErrors() {
    errlog.clear();
    return { ok: true };
  },

  // Raw miIO CSV recorded by the vacuum driver. Separate from the app log on
  // purpose: it is a dense per-poll trace meant to be exported and analysed,
  // not read line by line.
  async getLog({ homey }) {
    const devices = vacuums(homey);
    if (!devices.length) return { count: 0, csv: '' };
    const device = devices[0];
    return { count: device.getLogCount(), csv: device.getLogCsv() };
  },

  async clearLog({ homey }) {
    for (const device of vacuums(homey)) await device.clearLog();
    return { ok: true };
  },

  // Interview dump of every device paired to this app: endpoints + clusters.
  // Read from the settings page (or GET /api/app/com.jerome.zigbidouille/zigbee)
  // to share a device's Zigbee layout without copying from Homey's dev tool.
  async getZigbee({ homey }) {
    const out = [];
    const drivers = homey.drivers.getDrivers();
    for (const driver of Object.values(drivers)) {
      const devices = driver.getDevices();
      for (const device of Array.isArray(devices) ? devices : Object.values(devices)) {
        if (typeof device.describeNode !== 'function') continue;
        try {
          out.push(await device.describeNode());
        } catch (err) {
          out.push({ name: device.getName(), error: err.message });
        }
      }
    }
    return { devices: out };
  },
};
