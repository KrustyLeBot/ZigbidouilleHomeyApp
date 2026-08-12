'use strict';

// Backend for the "Shelly power (today)" dashboard widget.
//
// The history comes from the driver's own per-minute recorder
// (lib/power-history.js), which also backfills today from Insights at startup.

const errlog = require('../../lib/errlog');
const { deviceUuid: deviceId } = require('../../lib/device-uuid');

// One line per app run, written on the FIRST call to getToday. The widget
// polls every 60 s, so anything unconditional here would flood the log.
//
// This exists because "no log line at all" was ambiguous: a widget whose
// picker sends no id falls back to the first channel and takes a path that
// logs nothing, which is indistinguishable from the handler never running.
// This line separates the two, and prints what the matching actually saw.
let reportedCall = false;
let reportedChannels = false;

function reportCall(wanted, channels) {
  if (reportedCall) return;
  reportedCall = true;
  const seen = channels.map((d) => deviceId(d) || 'NULL').join(', ');
  errlog.info(
    'widget shelly-energy',
    `getToday called: picked=${wanted || 'NONE'} channels=[${seen}]`,
  );
}

function shellyChannels(homey) {
  try {
    return homey.drivers.getDriver('shelly-em-gen4').getDevices()
      .filter((d) => d.hasCapability('measure_power'));
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
    reportCall(wanted, channels);

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

    // A metered channel with no recorder means onNodeInit never reached the
    // point where it starts — worth a line, since the widget's "waiting for
    // the first reading" looks like patience rather than a failure.
    const history = typeof device.getPowerHistory === 'function'
      ? device.getPowerHistory()
      : null;
    if (!history) {
      errlog.debug('widget shelly-energy', `${device.getName()}: no power history recorder`);
      return { error: 'no_history', name: device.getName() };
    }

    return {
      name: device.getName(),
      points: history.points,
      kwh: history.kwh,
      power: history.power,
    };
  },
};
