'use strict';

const Homey = require('homey');
const MiioClient = require('../../lib/miio-client');
const { PROPERTIES } = require('../../lib/x20plus');

class X20PlusDriver extends Homey.Driver {
  async onPair(session) {
    session.setHandler('validate', async ({ address, token }) => {
      if (!/^[0-9a-fA-F]{32}$/.test(token || '')) {
        throw new Error(this.homey.__('pair.bad_token'));
      }

      // Prove we can actually talk to the robot before creating the device.
      // Generous timeout: the robot is often asleep and needs a few tries.
      const client = new MiioClient(address, token, { timeout: 10000 });
      try {
        const values = await client.getProperties(PROPERTIES);
        if (values.status === undefined) throw new Error(this.homey.__('pair.no_reply'));

        return {
          name: 'Xiaomi Robot Vacuum X20+',
          data: { id: `x20plus-${address}` },
          settings: { address, token },
        };
      } finally {
        client.destroy();
      }
    });
  }
}

module.exports = X20PlusDriver;
