'use strict';

// Philips/Signify manufacturer-specific cluster 0xFC00.
//
// The Hue Dimmer Switch does NOT report its buttons through standard clusters:
// it sends a single manufacturer command, `hueNotification`, carrying which
// button and which kind of event. zigbee-clusters does not ship this cluster,
// so it is declared here.
//
// Frame layout and semantics taken from the Zigbee2MQTT converter for RWL022
// (zigbee-herdsman-converters, src/lib/philips.ts). Deriving it from the
// device alone would have been guesswork — see CLAUDE.md on checking Z2M first.

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

const SIGNIFY_MANUFACTURER_ID = 0x100b;

const BUTTONS = { 1: 'on', 2: 'up', 3: 'down', 4: 'off' };
const ACTIONS = { 0: 'press', 1: 'hold', 2: 'press_release', 3: 'hold_release' };

class PhilipsSpecificCluster extends Cluster {
  static get ID() {
    return 0xfc00;
  }

  static get NAME() {
    return 'manuSpecificPhilips';
  }

  static get ATTRIBUTES() {
    return {
      // Writing this is what puts the switch into "send Hue notifications"
      // mode. Declaring manufacturerId lets zigbee-clusters set the
      // manufacturer-specific flag on the frame by itself.
      config: {
        id: 0x0031,
        type: ZCLDataTypes.uint16,
        manufacturerId: SIGNIFY_MANUFACTURER_ID,
      },
    };
  }

  static get COMMANDS() {
    return {
      hueNotification: {
        id: 0x00,
        // The device sends this to us; we never send it.
        direction: Cluster.DIRECTION_SERVER_TO_CLIENT,
        // REQUIRED, and easy to miss: the switch sends this frame with the
        // manufacturer-specific bit set, and Cluster#handleFrame only matches a
        // command whose `manufacturerId` presence mirrors that bit. Without it
        // the frame arrives, matches nothing, and the buttons are silent.
        manufacturerId: SIGNIFY_MANUFACTURER_ID,
        args: {
          button: ZCLDataTypes.uint8,
          unknown1: ZCLDataTypes.uint24,
          type: ZCLDataTypes.uint8,
          unknown2: ZCLDataTypes.uint8,
          // Counts up while a button is held; the repeat is what makes
          // "hold to change the volume" possible.
          time: ZCLDataTypes.uint8,
          unknown3: ZCLDataTypes.uint8,
        },
      },
    };
  }
}

Cluster.addCluster(PhilipsSpecificCluster);

// Turns a raw frame into { button, action }, or null for a combination we do
// not model — better than reporting the wrong button.
function decodeNotification(payload = {}) {
  const button = BUTTONS[payload.button];
  const action = ACTIONS[payload.type];
  if (!button || !action) return null;
  return { button, action, held: payload.time };
}

// NOTE: no BoundCluster here, on purpose. zigbee-clusters routes a frame by
// direction — Cluster receives `directionToClient=true`, BoundCluster receives
// `false`. `hueNotification` is server-to-client, so it lands on the cluster
// INSTANCE and is handled by assigning `cluster.onHueNotification`, the same
// pattern the CO detector uses for `onZoneStatusChangeNotification`. Binding a
// BoundCluster here looks right and silently never fires.

module.exports = {
  PhilipsSpecificCluster,
  SIGNIFY_MANUFACTURER_ID,
  BUTTONS,
  ACTIONS,
  decodeNotification,
};
