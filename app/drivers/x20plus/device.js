'use strict';

// Xiaomi Robot Vacuum X20+ (xiaomi.vacuum.c102gl).
//
// All behaviour lives in lib/miio-vacuum-device.js; this file only names the
// field map. See lib/x20plus.js for the map itself and FINDINGS.md for how each
// value was established — the published d109gl spec is wrong for this model.

const MiioVacuumDevice = require('../../lib/miio-vacuum-device');
const profile = require('../../lib/x20plus');

class X20PlusDevice extends MiioVacuumDevice {
  get profile() {
    return profile;
  }
}

module.exports = X20PlusDevice;
