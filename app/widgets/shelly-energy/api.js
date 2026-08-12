'use strict';

// Backend for the "Shelly energy (today)" dashboard widget: one figure, the
// imported energy since local midnight.
//
// It comes from lib/energy-today.js, which holds the meter reading as it stood
// at 00:00 — persisted across restarts, and recovered from Insights when the app
// is installed mid-day.

const errlog = require('../../lib/errlog');
const { deviceUuid: deviceId } = require('../../lib/device-uuid');

// Kept because the picker DOES go wrong: an id that matches no paired channel
// is reported below, with the ids that were compared. The "getToday was called
// at all" breadcrumb that used to live here is gone — it answered a question
// (does the handler run?) that is now answered by the widget showing a figure.
let reportedChannels = false;

// Once per app run per device: the widget polls every 60 s, so this would
// otherwise be a line a minute for as long as the state lasts.
const reportedNoCounter = new Set();

function reportNoCounter(device, hasMethod) {
  const name = device.getName();
  if (reportedNoCounter.has(name)) return;
  reportedNoCounter.add(name);
  errlog.info('widget shelly-energy',
    `${name}: no energy counter — getEnergyToday=${hasMethod ? 'present' : 'MISSING'}, `
    + `meter_power=${device.hasCapability('meter_power') ? 'yes' : 'NO'}, `
    + `value=${String(device.getCapabilityValue('meter_power'))}`);
}

function shellyChannels(homey) {
  try {
    return homey.drivers.getDriver('shelly-em-gen4').getDevices()
      .filter((d) => d.hasCapability('meter_power'));
  } catch (err) {
    // Driver absent from this install (or no channel paired yet).
    return [];
  }
}

module.exports = {
  // Legacy endpoint: the current frontend picks its device through
  // Homey.getDeviceIds() and never calls this. It is kept only because a
  // dashboard serving a CACHED older copy of index.html still does — and that
  // is precisely how a stale widget gives itself away in the log.
  async getChannels({ homey }) {
    if (!reportedChannels) {
      reportedChannels = true;
      errlog.info(
        'widget shelly-energy',
        'getChannels called — this endpoint is unused by the current widget, '
        + 'so the dashboard is running a cached older index.html',
      );
    }
    return shellyChannels(homey).map((d) => ({ id: deviceId(d), name: d.getName() }));
  },

  async getToday({ homey, query }) {
    const channels = shellyChannels(homey);
    if (!channels.length) return { error: 'no_device' };

    const wanted = query && query.device;

    let device = null;

    if (wanted) {
      device = channels.find((d) => deviceId(d) === wanted) || null;

      // The picker gave an id nothing matches. With a single metered channel
      // that is harmless — there is only one thing it can mean — so chart it
      // rather than show an error the user cannot act on. With several, refuse
      // instead of silently charting the wrong clamp.
      if (!device) {
        if (channels.length === 1) {
          device = channels[0];
        } else {
          errlog.add(
            'widget shelly-energy',
            new Error(`no device matches picked id ${wanted}; ids seen: ${channels.map(deviceId).join(', ')}`),
          );
          return { error: 'device_gone' };
        }
      }
    } else {
      device = channels[0];
    }

    // A metered channel with no counter means onNodeInit never reached the point
    // where it starts. At INFO, and once per app run: the widget's "waiting for
    // the first reading" looks like patience rather than a failure, and at debug
    // level this line was invisible by default — which is the whole reason the
    // state was undiagnosable.
    //
    // The three facts printed are exactly what separates the possible causes:
    // no `getEnergyToday` at all = the app is running an older build; the method
    // present but `meter_power` missing = the capability never got registered, so
    // the counter was skipped; both fine = init is simply still in flight.
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
