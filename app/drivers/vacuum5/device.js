'use strict';

// Xiaomi Robot Vacuum 5 (xiaomi.vacuum.ov31gl).
//
// All behaviour lives in lib/miio-vacuum-device.js; this file only names the
// field map. See lib/vacuum5.js for the map, which was established by sweeping
// the live robot — the published spec's status enum does not match it.

const MiioVacuumDevice = require('../../lib/miio-vacuum-device');
const profile = require('../../lib/vacuum5');

class Vacuum5Device extends MiioVacuumDevice {
  get profile() {
    return profile;
  }
}

module.exports = Vacuum5Device;
