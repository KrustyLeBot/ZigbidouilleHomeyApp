'use strict';

const Homey = require('homey');
const { getClient } = require('../../lib/imou-account');
const profile = require('../../lib/imou-cellpt');

class ImouCellPtDriver extends Homey.Driver {
  async onPairListDevices() {
    const api = getClient(this.homey);
    if (!api) throw new Error(this.homey.__('imou.not_configured'));

    const devices = await api.devices();
    const out = [];

    for (const device of devices) {
      const channel = (device.channels || []).find((c) => c.productId === profile.PRODUCT_ID);
      if (!channel) continue;

      out.push({
        name: channel.channelName || device.deviceId,
        data: { id: device.deviceId },
        store: { channelId: channel.channelId || '0' },
      });
    }

    return out;
  }
}

module.exports = ImouCellPtDriver;
