'use strict';

// Endpoints backing the settings page, so recent errors can be inspected from
// Homey without the CLI.

const errlog = require('./lib/errlog');
const { ImouClient } = require('./lib/imou-client');
const { rememberHost } = require('./lib/imou-account');
const { getClient: getSomfyClient } = require('./lib/somfy-account');

// Every miIO vacuum driver. Listing them explicitly rather than hardcoding one:
// the raw log used to reach only the X20+, so a paired Vacuum 5 recorded its
// trace faithfully and had no way to show it — the data was there, the export
// simply never asked for it.
//
// Add a new robot's driver id here when adding a driver, or its log is
// invisible in exactly the same silent way.
const VACUUM_DRIVERS = ['x20plus', 'vacuum5'];

// A driver may not exist on a given install, so this never throws — the
// settings page just shows an empty raw log.
function vacuums(homey) {
  const devices = [];
  for (const id of VACUUM_DRIVERS) {
    try {
      devices.push(...homey.drivers.getDriver(id).getDevices());
    } catch (err) {
      // Driver absent from this install: nothing to collect.
    }
  }
  return devices;
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
  // Returns EVERY vacuum's trace, one block per robot. It used to return
  // devices[0] only, which silently hid the second robot behind the first.
  //
  // The blocks are not merged into one table on purpose: the two models share
  // no field numbering, so their CSVs have different columns. A single header
  // would misalign one of them — and a misaligned column reads as real data.
  async getLog({ homey }) {
    const devices = vacuums(homey);
    if (!devices.length) return { count: 0, csv: '' };

    let count = 0;
    const blocks = [];
    for (const device of devices) {
      count += device.getLogCount();
      blocks.push(`# ${device.getName()} (${device.driver.id}) — ${device.getLogCount()} rows\n${device.getLogCsv()}`);
    }

    return { count, csv: blocks.join('\n\n') };
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

  // Backs the "Test connection" button on the settings page's Imou tab. Reads
  // whatever was just saved (Homey.set on the client resolves before this call
  // fires) rather than taking credentials as params, so the secret never
  // travels through this endpoint's own request body/logs either.
  //
  // Discovers the data centre from scratch every time rather than trusting a
  // previously saved host: the button exists specifically to catch a stale or
  // wrong host after the user edits it.
  async testImou({ homey }) {
    const appId = homey.settings.get('imou_app_id');
    const appSecret = homey.settings.get('imou_app_secret');
    if (!appId || !appSecret) {
      return { ok: false, error: homey.__('imou.not_configured') };
    }

    try {
      const host = await ImouClient.discoverHost(appId, appSecret);
      rememberHost(homey, host);

      const api = new ImouClient({ appId, appSecret, host });
      const devices = await api.devices();
      return { ok: true, count: devices.length, host };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  // Backs the "Test connection" button on the settings page's Somfy tab. Reads
  // whatever was just saved, same reasoning as testImou above — the secret
  // never travels through this endpoint's own body/logs.
  async testSomfy({ homey }) {
    const api = getSomfyClient(homey);
    if (!api) return { ok: false, error: homey.__('somfy.not_configured') };

    try {
      const sites = await api.getSites();
      return { ok: true, count: sites.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
};
