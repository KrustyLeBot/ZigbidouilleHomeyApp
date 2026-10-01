'use strict';

const { CLUSTER } = require('zigbee-clusters');
const ZigbidouilleDevice = require('./zigbee-device');
const {
  TuyaSpecificCluster,
  TuyaBoundCluster,
  TUYA_CLUSTER_ID,
  TUYA_TYPE,
  buildDatapointFrame,
  encodeValue,
  parseDatapoints,
} = require('./tuya-cluster'); // requiring this also registers the EF00 cluster

// MOES Fingerbot Plus (Tuya TS0001, _TZ3210_*) — a Zigbee finger that physically
// pushes a button. See lib/tuya-cluster.js for the EF00 protocol; the mapping
// below is lifted verbatim from the Zigbee2MQTT converter (TS0001_fingerbot in
// Koenkk/zigbee-herdsman-converters), which is ground truth per CLAUDE.md.
//
// HYBRID device, and this is the whole reason it is tractable:
//   - the PRESS itself is the STANDARD genOnOff cluster (id 6). In "click" mode
//     one On makes the arm push and spring back; in "switch" mode On holds it
//     down and Off releases. So `onoff` is a normal registerCapability, and the
//     flow "press" action is just an On command.
//   - everything else (mode, stroke limits, sustain, battery) is a Tuya DP on
//     the EF00 cluster, handled here.
//
// Datapoints (dp id -> meaning). Full map cross-checked against kkossev's
// Hubitat Fingerbot driver, the most complete reference:
//   0x01 switch · 0x04 battery(alt) · 0x65 mode · 0x66 down% · 0x67 sustain ·
//   0x68 reverse · 0x69 battery · 0x6a up% · 0x6b touch · 0x6c click count ·
//   0x6d custom program · 0x6e production test · 0x6f "sports statistics"
//   (a press counter — this is the dp=111 the unit spontaneously reports) ·
//   0x70 custom timing.
const DP = {
  MODE: 0x65, // enum: 0 click, 1 switch, 2 program
  LOWER: 0x66, // value %, down-movement limit (how far it pushes), 50..100
  DELAY: 0x67, // value s, sustain time (how long it holds), 0..10
  REVERSE: 0x68, // enum: 0 off, 1 on
  BATTERY: 0x69, // value %, battery (0..100)
  UPPER: 0x6a, // value %, up-movement limit (resting position), 0..50
  TOUCH: 0x6b, // bool: on-device touch button enabled
};

const MODES = ['click', 'switch', 'program']; // index == enum value

const ONOFF_ENDPOINT = 1;

function clamp(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.min(max, Math.max(min, Math.round(x)));
}

class FingerbotDevice extends ZigbidouilleDevice {
  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    // Uncomment while bringing a new unit up — dumps endpoints/clusters + frames.
    // this.enableDebug();
    // this.printNode();

    this._seq = 0;

    // The press. Standard genOnOff on endpoint 1 — the click rides this, never
    // the Tuya cluster. Plain registerCapability: On/Off from Homey is sent as a
    // command, and the device's own state reports flow back to the tile. No
    // custom reset behaviour.
    this.registerCapability('onoff', CLUSTER.ON_OFF, { endpoint: ONOFF_ENDPOINT });

    // The Tuya cluster carries config + battery. It only exists as an instance
    // if the paired node's descriptor listed cluster 61184 on this endpoint —
    // guard, so a node that pairs without it still gives a working press tile.
    const ep = zclNode.endpoints[ONOFF_ENDPOINT];
    this._tuya = ep && ep.clusters
      ? (ep.clusters.tuya || ep.clusters[TUYA_CLUSTER_ID])
      : null;

    if (this._tuya) {
      // Catch reports whichever direction the firmware uses:
      //  - server->client lands on these INSTANCE handlers;
      //  - client->server (what this Fingerbot actually does) lands on the
      //    BoundCluster below. Registering both is why battery/config finally
      //    arrive — the instance handlers alone received nothing.
      this._tuya.onDataReport = (payload) => this.onTuyaData(payload);
      this._tuya.onDataResponse = (payload) => this.onTuyaData(payload);
      this._tuya.onActiveStatusReport = (payload) => this.onTuyaData(payload);
      this._tuya.onActiveStatusReportAlt = (payload) => this.onTuyaData(payload);
      this._tuyaBound = new TuyaBoundCluster({ onData: (payload) => this.onTuyaData(payload) });
      try {
        zclNode.endpoints[ONOFF_ENDPOINT].bind(TuyaSpecificCluster.NAME, this._tuyaBound);
      } catch (err) {
        this.recordError('bind Tuya cluster', err);
      }
      this.note('init', 'Tuya EF00 cluster bound (instance + BoundCluster)');
      // Tuya end-devices stay silent until asked — pull the full datapoint dump
      // so battery and the current config populate, and so we can SEE that the
      // receive path works at all. Retried, because the device may be asleep.
      this.queryDatapoints();
    } else {
      // Not an error: the press still works. Only config/battery are unavailable
      // until the device is re-paired with the EF00 binding in place.
      this.note('init', 'no Tuya EF00 cluster on endpoint 1 — config/battery unavailable');
    }

    // Deliberately NOT pushing the stored settings to the device here: writing
    // LOWER/UPPER would move the arm on every restart. The device keeps its own
    // config; Homey's settings are synced FROM the device's reports (see
    // onTuyaData) and only written back when the user changes one (onSettings).
  }

  onOffCluster() {
    const ep = this.zclNode && this.zclNode.endpoints[ONOFF_ENDPOINT];
    return ep && ep.clusters ? ep.clusters.onOff : null;
  }

  // The flow "press" action: send On. In click mode the arm pushes and returns
  // on its own. The press wakes the device, so it is also a good moment to pull
  // its datapoints (battery) — piggyback a query.
  async press() {
    const onOff = this.onOffCluster();
    if (!onOff) throw new Error('onOff cluster unavailable');
    await onOff.setOn();
    this.setCapabilityValue('onoff', true).catch(() => {});
    this.queryDatapoints(1);
  }

  // Ask the device to report all its datapoints. Retried a few times because a
  // sleepy end-device only receives while it briefly polls its parent, and one
  // shot usually misses that window.
  queryDatapoints(times = 3) {
    if (!this._tuya) return;
    for (let i = 0; i < times; i++) {
      this.homey.setTimeout(() => {
        this._tuya.dataQuery()
          .then(() => this.debugNote('queryDatapoints', `sent (${i + 1}/${times})`))
          .catch((err) => this.debugNote('queryDatapoints', `failed: ${err.message}`));
      }, i * 3000);
    }
  }

  // Send a datapoint write, then REPEAT it a few times. A Fingerbot is a sleepy
  // end-device: the first frame is very often sent while it is asleep and the
  // parent's buffer drops it before the device polls — which reads exactly as
  // "the write was accepted by the radio but nothing changed". Config DPs are
  // idempotent, so re-sending the same value costs nothing and dramatically
  // raises the odds one frame lands while the device is awake.
  async sendDatapoint(dp, type, payload, repeats = 2) {
    if (!this._tuya) {
      this.recordError('sendDatapoint', new Error(`Tuya cluster unavailable (dp=${dp})`));
      return;
    }
    const frame = buildDatapointFrame(dp, type, payload);
    const fire = (attempt) => {
      this._seq = (this._seq + 1) & 0xff;
      // sendData (0x04), NOT dataRequest (0x00): this Fingerbot's converter
      // pins `tuyaSendCommand: "sendData"`, and it silently ignores 0x00.
      this._tuya
        .sendData({ status: 0, transid: this._seq, data: frame })
        .then(() => this.debugNote('sendDatapoint', `dp=${dp} attempt ${attempt}/${repeats} frame=${frame.toString('hex')} — sent`))
        .catch((err) => this.recordError(`sendDatapoint dp=${dp} attempt ${attempt}`, err));
    };
    // A light retry: with the correct command id one frame usually lands, but a
    // battery end-device can still miss one, so a single repeat is cheap
    // insurance (config DPs are idempotent).
    fire(1);
    for (let i = 1; i < repeats; i++) {
      this.homey.setTimeout(() => fire(i + 1), i * 3000);
    }
  }

  // Push one changed setting to the device. Ranges match the converter's
  // exposes, clamped so a bad manual entry cannot send the arm past its stops.
  async applySetting(key, value) {
    switch (key) {
      case 'mode': {
        const index = MODES.indexOf(value);
        if (index >= 0) await this.sendDatapoint(DP.MODE, TUYA_TYPE.ENUM, Buffer.from([index]));
        break;
      }
      case 'lower':
        await this.sendDatapoint(DP.LOWER, TUYA_TYPE.VALUE, encodeValue(clamp(value, 50, 100)));
        break;
      case 'upper':
        await this.sendDatapoint(DP.UPPER, TUYA_TYPE.VALUE, encodeValue(clamp(value, 0, 50)));
        break;
      case 'delay':
        await this.sendDatapoint(DP.DELAY, TUYA_TYPE.VALUE, encodeValue(clamp(value, 0, 10)));
        break;
      case 'reverse':
        await this.sendDatapoint(DP.REVERSE, TUYA_TYPE.ENUM, Buffer.from([value ? 1 : 0]));
        break;
      case 'touch':
        await this.sendDatapoint(DP.TOUCH, TUYA_TYPE.BOOL, Buffer.from([value ? 1 : 0]));
        break;
      default:
        break;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    this.debugNote('onSettings', `changed: ${changedKeys.join(', ')}`);
    for (const key of changedKeys) {
      // Serialised on purpose: this device is a sleepy end-device and a burst of
      // DP writes is a good way to make it drop half of them.
      // eslint-disable-next-line no-await-in-loop
      await this.applySetting(key, newSettings[key]);
    }
  }

  // A DP report from the device. Battery -> capability, and nothing else.
  //
  // The config DPs (mode/lower/upper/...) are DELIBERATELY not mirrored back
  // into Homey's settings. The device echoes a config DP the instant it is
  // written, and pushing that echo into setSettings fought the user's own edit:
  // Homey rejects a setSettings that lands while onSettings is still resolving,
  // so saving a new % appeared to "not change anything" or revert. The settings
  // are the source of truth for config; the device is only READ for battery.
  // (A config change made in the Smart Life app therefore will not reflect back
  // here — an acceptable trade for settings the user can actually edit.)
  onTuyaData(payload) {
    const dps = parseDatapoints(payload && payload.data);

    for (const { dp, type, value } of dps) {
      this.debugNote('tuya dp', `dp=${dp} type=${type} value=${value}`);
      // Battery is 0x69 as a real 0..100 percentage. NOT 0x04: on this variant
      // 0x04 is a battery-STATE enum (0 low / 1 mid / 2 high), and reading it as
      // a percentage showed "1%" on a healthy device. Everything else
      // (mode/positions/press counter 0x6f...) is left alone; config is
      // settings-driven (see the comment above this method).
      if (dp === DP.BATTERY && value >= 0 && value <= 100) {
        this.setCapabilityValue('measure_battery', clamp(value, 0, 100)).catch(() => {});
      }
    }
  }
}

module.exports = FingerbotDevice;
