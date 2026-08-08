'use strict';

// Imou Cell PT. All behaviour lives in lib/imou-camera-device.js; this file
// only names the switch map. See lib/imou-cellpt.js.

const ImouCameraDevice = require('../../lib/imou-camera-device');
const profile = require('../../lib/imou-cellpt');

class ImouCellPtDevice extends ImouCameraDevice {
  get profile() {
    return profile;
  }
}

module.exports = ImouCellPtDevice;
