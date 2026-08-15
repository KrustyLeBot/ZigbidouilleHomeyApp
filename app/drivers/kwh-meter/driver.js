'use strict';

// Pairing is a multi-select picker over every OTHER device on this Homey that
// exposes measure_power — not a fixed model, since this driver adopts
// whatever plug/appliance's own kWh reporting is missing or broken (the
// Sonoff double-counting problem this was built for, see README). Zigbidouille's
// own devices are excluded from the list: they either already publish a real
// meter_power (the Shelly) or would create a meter tracking a meter.

const Homey = require('homey');
const { getApi } = require('../../lib/kwh-meter-account');

class KwhMeterDriver extends Homey.Driver {
  async onPairListDevices() {
    const api = await getApi(this.homey);
    const devices = await api.devices.getDevices();
    const ownAppId = this.homey.manifest.id;

    return Object.values(devices)
      .filter((d) => Array.isArray(d.capabilities) && d.capabilities.includes('measure_power'))
      .filter((d) => !(typeof d.driverUri === 'string' && d.driverUri.includes(ownAppId)))
      .map((d) => ({
        name: d.name,
        data: { id: d.id },
        store: { sourceId: d.id },
      }));
  }
}

module.exports = KwhMeterDriver;
