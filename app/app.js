'use strict';

const Homey = require('homey');
// Uncomment while debugging a new device to dump every Zigbee frame the app
// sends/receives to the app logs. Very noisy — leave off in normal use.
// const { Cluster, debug } = require('zigbee-clusters');

class ZigbidouilleApp extends Homey.App {
  async onInit() {
    // debug(true); // pair with the line above to trace raw Zigbee traffic
    this.log('Zigbidouille started');
  }
}

module.exports = ZigbidouilleApp;
