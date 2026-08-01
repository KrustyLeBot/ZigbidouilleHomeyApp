'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

// Philips Hue Dimmer Switch v3 (RWL022), paired straight to Homey — no bridge.
// Pairing is learnmode-driven and handled by ZigBeeDriver from the manifest;
// the button decoding lives in device.js.
class HueDimmerV3Driver extends ZigBeeDriver {}

module.exports = HueDimmerV3Driver;
