'use strict';

const Homey = require('homey');
const { getClient } = require('../../lib/somfy-account');

class SomfyAlarmDriver extends Homey.Driver {
  // Pairing is a picker, not a form: the account (the SECONDARY Somfy Protect
  // login, see the settings page) is configured once in the app settings, so
  // by the time anyone pairs there is nothing left to type — just pick the
  // site from the list the cloud already knows about. Same pattern as the
  // Imou cameras (drivers/imou-ranger2c/driver.js).
  async onPairListDevices() {
    const api = getClient(this.homey);
    if (!api) throw new Error(this.homey.__('somfy.not_configured'));

    const sites = await api.getSites();
    return sites.map((site) => ({
      name: site.label || site.name || 'Somfy Protect',
      data: { id: site.site_id },
    }));
  }
}

module.exports = SomfyAlarmDriver;
