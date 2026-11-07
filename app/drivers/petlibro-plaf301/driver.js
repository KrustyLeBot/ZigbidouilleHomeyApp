'use strict';

const Homey = require('homey');
const bridge = require('../../lib/petlibro-bridge');

class PetlibroPlaf301Driver extends Homey.Driver {
  // Pairing is a picker over the feeders the bridge knows — any feeder that
  // has connected to it at least once. The bridge address and login are set
  // once in the app settings (Settings -> Petlibro), same pattern as Somfy.
  async onPairListDevices() {
    const { feeders } = await bridge.request(this.homey, 'GET', '/api/feeders');
    if (!feeders.length) throw new Error(this.homey.__('petlibro.no_feeder'));
    return feeders.map((f) => ({
      name: `Petlibro One RFID ${f.serial.slice(-4)}`,
      data: { id: f.serial },
    }));
  }
}

module.exports = PetlibroPlaf301Driver;
