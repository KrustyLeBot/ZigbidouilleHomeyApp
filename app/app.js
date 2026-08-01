'use strict';

const Homey = require('homey');
// Uncomment while debugging a new device to dump every Zigbee frame the app
// sends/receives to the app logs. Very noisy — leave off in normal use.
// const { Cluster, debug } = require('zigbee-clusters');

const errlog = require('./lib/errlog');

class ZigbidouilleApp extends Homey.App {
  async onInit() {
    // debug(true); // pair with the line above to trace raw Zigbee traffic
    // Restores the log persisted by the previous run, so evidence from a
    // pairing that crashed the app is still readable in the settings page.
    errlog.init(this.homey);
    errlog.info('app', 'Zigbidouille started');
    this.log('Zigbidouille started');
  }
}

module.exports = ZigbidouilleApp;
