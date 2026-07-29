'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

// Heiman HS-720ES carbon-monoxide detector. Pairing (fingerprint match +
// learnmode) is handled by ZigBeeDriver from the manifest; the device-specific
// cluster mapping lives in device.js.
class CoHS720ESDriver extends ZigBeeDriver {}

module.exports = CoHS720ESDriver;
