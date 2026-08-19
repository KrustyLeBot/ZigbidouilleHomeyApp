'use strict';

// Backend for the "Energy (today)" dashboard widget: one figure, the energy
// imported since local midnight, for ANY of this app's devices that carries an
// incremental kWh counter (`meter_power`).
//
// It started life bound to the Shelly EM Gen4 alone, hence the widget id and
// folder name (`shelly-energy`, kept so already-placed widgets keep working).
// It now serves every driver whose device runs lib/energy-today.js and exposes
// getEnergyToday() — the Shelly channels and the virtual kWh meters both do.
// The device is chosen in the widget's own settings (a `meter_power` picker),
// and identified here by Homey's device UUID.

const errlog = require('../../lib/errlog');
const { deviceUuid: deviceId } = require('../../lib/device-uuid');

// Kept because the picker DOES go wrong: an id that matches no device is
// reported below, with the ids that were compared.
let reportedDevices = false;

// Once per app run per device: the widget polls every 60 s, so this would
// otherwise be a line a minute for as long as the state lasts.
const reportedNoCounter = new Set();

function reportNoCounter(device, hasMethod) {
  const name = device.getName();
  if (reportedNoCounter.has(name)) return;
  reportedNoCounter.add(name);
  errlog.info('widget energy-today',
    `${name}: no energy counter — getEnergyToday=${hasMethod ? 'present' : 'MISSING'}, `
    + `meter_power=${device.hasCapability('meter_power') ? 'yes' : 'NO'}, `
    + `value=${String(device.getCapabilityValue('meter_power'))}`);
}

// Every device in this app that can feed the widget: has a kWh counter AND runs
// the today's-energy tracker. Both conditions matter — a Shelly relay sub-device
// has neither, and a driver that has meter_power but never started EnergyToday
// (a bug) is better skipped with a log line than charted from a method that
// isn't there.
function meteredDevices(homey) {
  const out = [];
  let drivers = {};
  try {
    drivers = homey.drivers.getDrivers();
  } catch (err) {
    return out;
  }
  for (const driver of Object.values(drivers)) {
    let devices = [];
    try {
      devices = driver.getDevices();
    } catch (err) {
      continue; // a driver mid-init can throw; the others still count
    }
    for (const device of devices) {
      if (device.hasCapability('meter_power') && typeof device.getEnergyToday === 'function') {
        out.push(device);
      }
    }
  }
  return out;
}

module.exports = {
  // Legacy endpoint: the current frontend picks its device through
  // Homey.getDeviceIds() and never calls this. It is kept only because a
  // dashboard serving a CACHED older copy of index.html still does — and that
  // is precisely how a stale widget gives itself away in the log.
  async getChannels({ homey }) {
    if (!reportedDevices) {
      reportedDevices = true;
      errlog.info(
        'widget energy-today',
        'getChannels called — this endpoint is unused by the current widget, '
        + 'so the dashboard is running a cached older index.html',
      );
    }
    return meteredDevices(homey).map((d) => ({ id: deviceId(d), name: d.getName() }));
  },

  async getToday({ homey, query }) {
    const devices = meteredDevices(homey);
    if (!devices.length) return { error: 'no_device' };

    const wanted = query && query.device;

    let device = null;

    if (wanted) {
      device = devices.find((d) => deviceId(d) === wanted) || null;

      // The picker gave an id nothing matches. With a single metered device
      // that is harmless — there is only one thing it can mean — so chart it
      // rather than show an error the user cannot act on. With several, refuse
      // instead of silently charting the wrong one.
      if (!device) {
        if (devices.length === 1) {
          device = devices[0];
        } else {
          errlog.add(
            'widget energy-today',
            new Error(`no device matches picked id ${wanted}; ids seen: ${devices.map(deviceId).join(', ')}`),
          );
          return { error: 'device_gone' };
        }
      }
    } else {
      device = devices[0];
    }

    // A metered device with no counter means its init never reached the point
    // where EnergyToday starts. At INFO, and once per app run: the widget's
    // "waiting for the first reading" looks like patience rather than a failure,
    // and at debug level this line was invisible by default.
    const hasMethod = typeof device.getEnergyToday === 'function';
    const today = hasMethod ? device.getEnergyToday() : null;
    if (!today) {
      reportNoCounter(device, hasMethod);
      return { error: 'no_history', name: device.getName() };
    }

    return {
      name: device.getName(),
      kwh: today.kwh,
      partial: today.partial,
    };
  },
};
