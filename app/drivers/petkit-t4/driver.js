'use strict';

const Homey = require('homey');
const { EsphomeWebClient } = require('../../lib/esphome-web-client');

class PetkitT4Driver extends Homey.Driver {
  // Pairing asks for the box's IP and its web login (web_username/web_password
  // in the firmware's secrets.yaml), then proves both by reading an entity only
  // our firmware has — a stock or plain-Triskae box fails here, clearly.
  async onPair(session) {
    session.setHandler('validate', async ({ address, username, password }) => {
      const host = String(address || '').trim();
      if (!host) throw new Error(this.homey.__('petkit.pair.no_address'));
      const client = new EsphomeWebClient({ host, username, password });
      try {
        await client.get('sensor', 'Visit Count');
      } catch (err) {
        if (err.status === 401) throw new Error(this.homey.__('petkit.pair.bad_login'));
        if (err.status === 404) throw new Error(this.homey.__('petkit.pair.not_our_firmware'));
        throw new Error(this.homey.__('petkit.pair.unreachable', { error: err.message }));
      }
      return {
        name: 'Petkit Pura Max 2',
        data: { id: `petkit-t4-${host}` },
        settings: { address: host, username, password },
      };
    });
  }
}

module.exports = PetkitT4Driver;
