'use strict';

const { CLUSTER } = require('zigbee-clusters');
const ZigbidouilleDevice = require('../../lib/zigbee-device');

// Heiman HS-720ES — Zigbee carbon-monoxide detector.
//
// Like most Zigbee alarm sensors it uses the IAS Zone cluster (id 1280): the
// device does NOT report a plain attribute on alarm, it sends a
// zoneStatusChangeNotification COMMAND. We listen for that, and also read the
// zoneStatus attribute once at startup so a Homey restart re-syncs the tile.
//
// zoneStatus is a bitmap; the bits we care about:
//   alarm1  -> CO detected            -> alarm_co
//   battery -> low battery            -> alarm_battery
//   tamper  -> housing opened/removed -> alarm_tamper (optional)
//
// The endpoint and exact fingerprint below MUST be confirmed against a real
// unit via Homey Developer Tools -> Zigbee before this can pair. See CLAUDE.md.
const IAS_ENDPOINT = 1;

class CoHS720ESDevice extends ZigbidouilleDevice {
  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    // Uncomment while bringing the device up: dumps its endpoints/clusters and
    // every frame to the app logs.
    // this.enableDebug();
    // this.printNode();

    const iasZone = zclNode.endpoints[IAS_ENDPOINT].clusters[CLUSTER.IAS_ZONE.NAME];

    // Some IAS devices refuse to send alarms until they are "enrolled": they ask
    // the coordinator for permission and expect an enroll response. Answer it.
    iasZone.onZoneEnrollRequest = () => {
      iasZone
        .zoneEnrollResponse({ enrollResponseCode: 0, zoneId: 10 })
        .catch((err) => this.recordError('zoneEnrollResponse', err));
    };

    // The alarm itself: fires whenever the detector changes state.
    iasZone.onZoneStatusChangeNotification = (payload) => {
      this.onZoneStatus(payload.zoneStatus);
    };

    // Read the current state once, so a restart while an alarm is active (or
    // while all-clear) shows the right value instead of a stale one.
    try {
      const { zoneStatus } = await iasZone.readAttributes(['zoneStatus']);
      this.onZoneStatus(zoneStatus);
    } catch (err) {
      // Expected, not an error: this is a sleepy battery end-device, so it is
      // usually unreachable at init ("could not reach device"). The alarm still
      // works — it arrives as a zoneStatusChangeNotification the moment the
      // detector fires. Logged to the app log only, never to the error panel,
      // which would otherwise fill with noise on every restart.
      this.log('initial zoneStatus read skipped (device asleep):', err.message);
    }

    // Battery percentage, if the device exposes the Power Configuration cluster.
    // homey-zigbeedriver's built-in handler reads batteryPercentageRemaining and
    // halves it (Zigbee reports 0-200). Sleepy device: rely on its own reports,
    // never poll.
    if (this.hasCapability('measure_battery')) {
      this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
        getOpts: { getOnStart: true },
        reportOpts: {
          configureAttributeReporting: {
            minInterval: 3600, // at most hourly
            maxInterval: 43200, // at least every 12h
            minChange: 2, // = 1% (units are half-percent)
          },
        },
      });
    }
  }

  // zoneStatus arrives as a parsed bitmap object from zigbee-clusters (named
  // boolean bits), or as a raw number when read as an attribute — handle both.
  onZoneStatus(zoneStatus) {
    const bit = (name, index) =>
      typeof zoneStatus === 'object' && zoneStatus !== null
        ? Boolean(zoneStatus[name])
        : ((Number(zoneStatus) >> index) & 1) === 1;

    const co = bit('alarm1', 0);
    const batteryLow = bit('battery', 3);

    this.setCapabilityValue('alarm_co', co).catch((err) =>
      this.recordError('set alarm_co', err));

    if (this.hasCapability('alarm_battery')) {
      this.setCapabilityValue('alarm_battery', batteryLow).catch((err) =>
        this.recordError('set alarm_battery', err));
    }
  }
}

module.exports = CoHS720ESDevice;
