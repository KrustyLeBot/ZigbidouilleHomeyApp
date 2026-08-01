'use strict';

const { CLUSTER } = require('zigbee-clusters');
const ZigbidouilleDevice = require('../../lib/zigbee-device');
const { PhilipsSpecificCluster, decodeNotification } = require('../../lib/philips-hue-cluster');

const ENDPOINT = 1;
// The switch repeats `hold` roughly every 0.8 s while a button is held down.
// Flows fire on each repeat, which is what allows "hold to change the volume".

class HueDimmerV3Device extends ZigbidouilleDevice {
  async onNodeInit({ zclNode }) {
    try {
      await super.onNodeInit({ zclNode });

      // `hueNotification` is a server-to-client command, so zigbee-clusters
      // delivers it to the cluster INSTANCE — assigning onHueNotification is
      // the way to catch it. (A BoundCluster only receives client-to-server
      // frames; using one here bound cleanly and never fired.)
      const philips = zclNode.endpoints[ENDPOINT].clusters[PhilipsSpecificCluster.NAME];
      philips.onHueNotification = (payload) => {
        const event = decodeNotification(payload);
        if (event) this.onButton(event);
        else this.debugNote('button', `unmapped payload ${JSON.stringify(payload)}`);
      };

      await this.enableHueNotifications(zclNode);

      this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
        getOpts: { getOnStart: true },
        reportOpts: {
          configureAttributeReporting: {
            minInterval: 3600, // at most hourly
            maxInterval: 43200, // at least every 12h
            minChange: 2, // = 1% (the attribute counts half-percents)
          },
        },
      });

      this.debugNote('init', 'hue dimmer ready');
    } catch (err) {
      // Never rethrow: a failure here must not make the remote unavailable,
      // the button events may well still arrive.
      this.recordError('onNodeInit', err);
    }
  }

  // Without this write the switch keeps talking in plain on/off and level
  // commands and never sends hueNotification, so no button would be reported.
  // Best-effort: some firmwares are already in the right mode, and a sleeping
  // battery device often misses the first write.
  async enableHueNotifications(zclNode) {
    try {
      await zclNode.endpoints[ENDPOINT].clusters[PhilipsSpecificCluster.NAME]
        .writeAttributes({ config: 0x000b });
      this.debugNote('init', 'hue notification mode enabled');
    } catch (err) {
      this.debugNote('init', `could not write hue config (may already be set): ${err.message}`);
    }
  }

  onButton({ button, action, held }) {
    this.debugNote('button', `${button}_${action} (held ${held})`);

    // One card with two dropdowns rather than sixteen separate cards: the user
    // picks the button and the kind of press in the flow itself.
    this.homey.flow
      .getDeviceTriggerCard('hue_dimmer_pressed')
      .trigger(this, { button, action }, { button, action })
      .catch((err) => this.recordError('trigger', err));
  }
}

module.exports = HueDimmerV3Device;
