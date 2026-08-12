'use strict';

// Backend for the "Somfy alarm" dashboard widget — a Somfy-style triangle
// picker: tap a corner to arm, switch to night mode, or disarm. Both the read
// and the write go through the device (lib/somfy-alarm-device.js), so this is
// just plumbing — the account, the client, and the error logging all already
// live there.

const { deviceUuid: deviceId } = require('../../lib/device-uuid');

function alarmDevices(homey) {
  try {
    return homey.drivers.getDriver('somfy-alarm').getDevices()
      .filter((d) => d.hasCapability('homealarm_state'));
  } catch (err) {
    // Driver absent from this install (or nothing paired yet).
    return [];
  }
}

function pickDevice(homey, wanted) {
  const devices = alarmDevices(homey);
  if (!devices.length) return { error: 'no_device' };

  if (wanted) {
    const found = devices.find((d) => deviceId(d) === wanted);
    if (found) return { device: found };
    // Same "a single device forgives a stale picked id" reasoning as the
    // Shelly widget (app/widgets/shelly-energy/api.js) — with several alarms
    // paired this would refuse instead of guessing which one.
    if (devices.length === 1) return { device: devices[0] };
    return { error: 'device_gone' };
  }
  return { device: devices[0] };
}

module.exports = {
  async getState({ homey, query }) {
    const result = pickDevice(homey, query && query.device);
    if (result.error) return { error: result.error };
    const device = result.device;

    return {
      name: device.getName(),
      state: device.getCapabilityValue('homealarm_state'),
      triggered: Boolean(device.getCapabilityValue('alarm_generic')),
      available: device.getAvailable(),
    };
  },

  async setState({ homey, query, body }) {
    const result = pickDevice(homey, query && query.device);
    if (result.error) return { error: result.error };
    const device = result.device;

    const state = body && body.state;
    if (!state) return { error: 'no_state' };

    try {
      await device.setSecurityLevel(state);
      return {
        state: device.getCapabilityValue('homealarm_state'),
        triggered: Boolean(device.getCapabilityValue('alarm_generic')),
      };
    } catch (err) {
      // A genuine failure is already logged by the client's own onError hook
      // (lib/somfy-account.js) — this just tells the widget to stop spinning
      // rather than lie about the new state.
      return { error: 'set_failed', message: err.message };
    }
  },
};
