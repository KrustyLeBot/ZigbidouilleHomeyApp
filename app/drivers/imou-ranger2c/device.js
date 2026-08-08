'use strict';

// Imou Ranger 2C. All behaviour lives in lib/imou-camera-device.js; this file
// only names the switch map. See lib/imou-ranger2c.js.

const ImouCameraDevice = require('../../lib/imou-camera-device');
const profile = require('../../lib/imou-ranger2c');

class ImouRanger2cDevice extends ImouCameraDevice {
  get profile() {
    return profile;
  }
}

module.exports = ImouRanger2cDevice;
