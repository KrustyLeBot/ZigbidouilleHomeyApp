'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');
const errlog = require('../../lib/errlog');

// Shelly EM Gen4 — Zigbee energy meter: 2 CT-clamp channels + 1 dry contact.
// One physical node is exposed as THREE Homey devices (see the `zigbee.devices`
// block in app.json): the root device is channel A, plus sub-devices `channel2`
// and `relay`. device.js branches on subDeviceId.
class ShellyEmGen4Driver extends ZigBeeDriver {
  // Pairing here has been unreliable and leaves nothing behind when it fails.
  // Only a marker is logged — deliberately NOT intercepting the session
  // handlers: Zigbee pairing is learnmode-driven and handled entirely by
  // ZigBeeDriver, so wrapping its handlers risks breaking the very flow being
  // debugged. The useful detail comes from device.js breadcrumbs, which run
  // once the node is joining.
  async onPair(session) {
    errlog.info('pair', 'pairing session started');
    return super.onPair(session);
  }
}

module.exports = ShellyEmGen4Driver;
