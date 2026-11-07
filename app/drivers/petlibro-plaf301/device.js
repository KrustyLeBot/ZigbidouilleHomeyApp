'use strict';

// Petlibro One RFID Smart Feeder (PLAF301). All behaviour lives in
// lib/petlibro-feeder-device.js; the feeder itself is driven by petlibro-bridge
// (bridge/petlibro), which this device only reads from and sends commands to.

const PetlibroFeederDevice = require('../../lib/petlibro-feeder-device');

module.exports = PetlibroFeederDevice;
