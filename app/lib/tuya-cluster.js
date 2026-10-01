'use strict';

// Tuya manufacturer cluster 0xEF00 ("tuya") for zigbee-clusters.
//
// This is the FIRST Tuya device in this app, and Tuya's Zigbee is unlike
// everything else here: instead of exposing standard clusters, a Tuya node
// tunnels every non-trivial function through one proprietary cluster (0xEF00)
// as a stream of "datapoints" (DPs). zigbee-clusters ships no definition for
// it, so this file adds one, and lib/fingerbot-device.js is the first user.
//
// WHY a cluster at all, and not raw frames: the app's hard rule is "never raw
// frames" (see CLAUDE.md). Modelling EF00 as a proper Cluster keeps that rule —
// sending a DP is a normal `cluster.setData(...)` call, and receiving one is a
// normal `cluster.onDataReport = ...` handler, exactly like every other driver.
//
// The Fingerbot Plus is a HYBRID: its actual button press rides the STANDARD
// genOnOff cluster (id 6), and only its configuration (mode, stroke limits,
// sustain, battery) comes through EF00. So EF00 here is config + battery, never
// the click itself.
//
// The wire format of one EF00 command is:
//
//   [ status(1) ][ transid(1) ][ dp(1) ][ type(1) ][ len(2, BIG-endian) ][ data(len) ]
//
// and a single frame may carry several DP blocks back-to-back. The two bytes
// before the first DP are read here as status+transid; zigbee-herdsman reads
// the same two bytes as one 16-bit sequence number — identical on the wire,
// and Tuya devices do not care what value setData carries there.
//
// The len field is BIG-endian and the numeric value payload is BIG-endian too.
// ZCLDataTypes are little-endian, so the DP block is carried as one opaque
// `buffer` arg and encoded/decoded here by hand — that is the whole reason this
// file does its own byte work instead of declaring typed struct fields.

const { Cluster, BoundCluster, ZCLDataTypes } = require('zigbee-clusters');

const TUYA_CLUSTER_ID = 0xEF00; // 61184

// Tuya DP value types (the `type` byte of a DP block).
const TYPE = {
  RAW: 0,
  BOOL: 1,
  VALUE: 2, // 4-byte big-endian integer
  STRING: 3,
  ENUM: 4, // 1 byte
  BITMAP: 5,
};

// Every EF00 command shares the same body: two leading bytes then an opaque
// run of DP blocks. Declaring `data` as a trailing `buffer` (length -0, i.e.
// "to end of frame") hands us the raw bytes to parse ourselves.
const COMMAND_ARGS = {
  status: ZCLDataTypes.uint8,
  transid: ZCLDataTypes.uint8,
  data: ZCLDataTypes.buffer,
};

class TuyaSpecificCluster extends Cluster {
  static get ID() {
    return TUYA_CLUSTER_ID;
  }

  static get NAME() {
    return 'tuya';
  }

  static get ATTRIBUTES() {
    return {}; // EF00 has no readable attributes — everything is a command
  }

  static get COMMANDS() {
    return {
      // Coordinator -> device: write a datapoint.
      //
      // TWO write commands exist and they are NOT interchangeable per device:
      //   dataRequest (0x00) — the common one.
      //   sendData    (0x04) — what THIS Fingerbot needs. Its Zigbee2MQTT
      //                        converter says `tuyaSendCommand: "sendData"`,
      //                        i.e. the device ignores 0x00 and only acts on
      //                        0x04. Writing via 0x00 was accepted by the radio
      //                        and silently did nothing — the "% changes
      //                        nothing" bug. The driver picks which to use.
      dataRequest: { id: 0, args: COMMAND_ARGS },
      sendData: { id: 4, args: COMMAND_ARGS },

      // Coordinator -> device: ask the device to report ALL its datapoints.
      // Many Tuya end-devices say NOTHING until queried — no battery, no config
      // echo — so without sending this at init the receive side looks dead even
      // though it works. Empty payload, command id 0x03 (Tuya "dataQuery").
      dataQuery: { id: 3 },

      // Device -> coordinator. A device reports datapoints through any of these,
      // and which one is firmware-dependent: dataResponse (0x01, a reply),
      // dataReport (0x02, spontaneous), or the "active status report" pair
      // (0x05/0x06) that some Tuya firmwares use instead. All carry the same DP
      // body, so the driver points every handler at one parser.
      //
      // NO `direction` on purpose. A Cluster INSTANCE handler only sees
      // directionToClient=true frames; this Fingerbot reports client->server,
      // which only a BoundCluster catches. Leaving direction unset lets the same
      // definition match in both places (instance handler AND TuyaBoundCluster),
      // so reports are caught whichever way the firmware sends them. Marking
      // them SERVER_TO_CLIENT made the BoundCluster filter them out. See
      // docs/fingerprints.md.
      dataResponse: { id: 1, args: COMMAND_ARGS },
      dataReport: { id: 2, args: COMMAND_ARGS },
      activeStatusReportAlt: { id: 5, args: COMMAND_ARGS },
      activeStatusReport: { id: 6, args: COMMAND_ARGS },
    };
  }
}

Cluster.addCluster(TuyaSpecificCluster);

// The receive side for a device that sends its DP reports client->server.
// zigbee-clusters routes those to a BoundCluster bound on the endpoint, not to
// the cluster instance — so a driver binds one of these AND sets the instance
// handlers, and whichever direction the firmware uses is caught. The method
// names must match the command names (dataReport / dataResponse).
class TuyaBoundCluster extends BoundCluster {
  constructor({ onData } = {}) {
    super();
    this._onData = typeof onData === 'function' ? onData : () => {};
  }

  dataReport(payload, meta, frame, rawFrame) {
    this._onData(payload, meta, frame, rawFrame);
  }

  dataResponse(payload, meta, frame, rawFrame) {
    this._onData(payload, meta, frame, rawFrame);
  }

  activeStatusReport(payload, meta, frame, rawFrame) {
    this._onData(payload, meta, frame, rawFrame);
  }

  activeStatusReportAlt(payload, meta, frame, rawFrame) {
    this._onData(payload, meta, frame, rawFrame);
  }
}

// --- DP frame helpers (all big-endian, per the Tuya wire format) -------------

// Build the DP block for one datapoint: dp, type, 2-byte BE length, payload.
function buildDatapointFrame(dp, type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.from([dp, type, (body.length >> 8) & 0xff, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

// A 4-byte big-endian integer payload, for TYPE.VALUE datapoints.
function encodeValue(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n >>> 0, 0);
  return buf;
}

// Decode the numeric payload of a TYPE.VALUE (or raw numeric) DP: big-endian,
// whatever its length. readUIntBE caps at 6 bytes, which covers every Tuya
// value (they are 4).
function decodeValue(buf) {
  if (!buf || !buf.length) return 0;
  return buf.readUIntBE(0, Math.min(buf.length, 6));
}

// Walk a command body's `data` buffer into an array of decoded datapoints.
// One frame may hold several; a truncated tail is dropped rather than throwing,
// since a malformed report must not take down onDataReport.
function parseDatapoints(data) {
  const out = [];
  if (!Buffer.isBuffer(data)) return out;
  let offset = 0;
  while (offset + 4 <= data.length) {
    const dp = data[offset];
    const type = data[offset + 1];
    const len = data.readUInt16BE(offset + 2);
    const start = offset + 4;
    if (start + len > data.length) break; // truncated — stop, keep what parsed
    const raw = data.slice(start, start + len);

    let value;
    switch (type) {
      case TYPE.BOOL: value = raw.length > 0 && raw[0] !== 0; break;
      case TYPE.ENUM: value = raw.length > 0 ? raw[0] : 0; break;
      case TYPE.VALUE: value = decodeValue(raw); break;
      default: value = raw; // RAW / STRING / BITMAP — leave as bytes
    }

    out.push({ dp, type, value, raw });
    offset = start + len;
  }
  return out;
}

module.exports = {
  TuyaSpecificCluster,
  TuyaBoundCluster,
  TUYA_CLUSTER_ID,
  TUYA_TYPE: TYPE,
  buildDatapointFrame,
  encodeValue,
  decodeValue,
  parseDatapoints,
};
