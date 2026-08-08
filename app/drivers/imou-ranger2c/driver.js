'use strict';

const Homey = require('homey');
const { getClient } = require('../../lib/imou-account');
const profile = require('../../lib/imou-ranger2c');

class ImouRanger2cDriver extends Homey.Driver {
  // Pairing is a picker, not a form: the account's app ID/secret are
  // configured once in the APP settings (Settings -> Imou tab), so by the time
  // anyone pairs a camera there is nothing left to type — just pick it from
  // the list the cloud already knows about.
  async onPairListDevices() {
    const api = getClient(this.homey);
    if (!api) throw new Error(this.homey.__('imou.not_configured'));

    const devices = await api.devices();
    const out = [];

    for (const device of devices) {
      const channel = (device.channels || []).find((c) => c.productId === profile.PRODUCT_ID);
      if (!channel) continue; // a different Imou model — not this driver's

      out.push({
        name: channel.channelName || device.deviceId,
        data: { id: device.deviceId },
        store: { channelId: channel.channelId || '0' },
      });
    }

    return out;
  }
}

module.exports = ImouRanger2cDriver;
