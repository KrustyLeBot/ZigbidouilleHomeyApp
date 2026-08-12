'use strict';

// Homey's own device id (a UUID) for a Device instance.
//
// WHY this is not simply `device.id`: the Apps SDK does NOT document any id
// property on Device — checked against the SDK v3 reference, which lists
// getData/getName/getSetting and friends but nothing carrying the UUID. Yet
// the widget device picker hands the frontend exactly those UUIDs, and the
// documented way to use them is to iterate getDevices() and match. So the id
// IS on the instance, just unnamed by the docs.
//
// Reading `device.id` therefore yielded `undefined`, and every comparison
// against it silently failed — which cost a long detour: an Insights URI built
// as `homey:device:undefined:...`, a device picker that never matched, and a
// widget that charted the wrong channel. Discover it instead of hardcoding a
// guess, and say in the log which property it came from.

const errlog = require('./errlog');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `__id` is the one that actually carries it — confirmed at runtime on Homey
// firmware 12.x by the scan below, which logged where it found it. The rest
// stay as fallbacks precisely because the name is undocumented and free to
// change without notice.
const ID_KEYS = ['__id', 'id', 'uuid', 'deviceId'];

let reportedKey = null;

// Verbose-only: this said which undocumented property carried the UUID while
// that was still an open question. It is `__id`, it is written down above, and
// the line was one per app run saying so again. It stays because the property is
// undocumented and free to change — the day it does, this is the fastest way to
// see what it changed to.
function reportKey(key) {
  if (reportedKey === key) return;
  reportedKey = key;
  errlog.debug('device id', `resolved from "${key}"`);
}

function deviceUuid(device) {
  if (!device) return null;

  for (const key of ID_KEYS) {
    if (typeof device[key] === 'string' && UUID.test(device[key])) {
      reportKey(key);
      return device[key];
    }
  }

  // Last resort: scan the instance for a UUID-shaped value. The Zigbee `token`
  // in getData() is a 16-hex-char IEEE address, so it cannot be mistaken for
  // one.
  for (const key of Object.keys(device)) {
    const value = device[key];
    if (typeof value === 'string' && UUID.test(value)) {
      reportKey(key);
      return value;
    }
  }

  return null;
}

module.exports = { deviceUuid };
