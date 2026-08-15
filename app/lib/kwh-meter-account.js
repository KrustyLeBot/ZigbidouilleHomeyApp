'use strict';

// One HomeyAPI instance and one 'delete' subscription shared by every virtual
// kWh meter device — same reasoning as lib/imou-account.js and
// lib/somfy-events.js: building a HomeyAPI instance costs a token fetch, and
// N virtual meters each opening their own would multiply that for nothing.

const { HomeyAPI } = require('homey-api');
const errlog = require('./errlog');

let apiPromise = null;
let deleteListenerBound = false;
const deleteHandlers = new Map(); // sourceId -> Set<handler>

function getApi(homey) {
  if (!apiPromise) {
    apiPromise = HomeyAPI.createAppAPI({ homey })
      .then((api) => {
        bindDeleteListener(api);
        return api;
      })
      .catch((err) => {
        apiPromise = null; // let a later device retry rather than cache a failure
        throw err;
      });
  }
  return apiPromise;
}

// NOT yet confirmed live: homey-api's device manager is expected to emit
// 'delete' with the removed device, mirroring the core SDK manager, but this
// has not been observed against a real deletion. If it never fires in
// practice, a deleted source is still caught the next time its own device
// tries to read it (see kwh-meter-device.js connectSource) — this is a
// faster path, not the only one, so a wrong assumption here degrades rather
// than breaks the "source deleted" handling.
function bindDeleteListener(api) {
  if (deleteListenerBound) return;
  deleteListenerBound = true;
  try {
    api.devices.on('delete', (device) => {
      const id = device && (device.id || device);
      const handlers = deleteHandlers.get(id);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler();
        } catch (err) {
          errlog.add('kwh-meter: delete handler failed', err);
        }
      }
    });
  } catch (err) {
    errlog.info('kwh-meter', `could not bind the devices delete listener: ${err.message}`);
  }
}

function onSourceDeleted(sourceId, handler) {
  if (!deleteHandlers.has(sourceId)) deleteHandlers.set(sourceId, new Set());
  deleteHandlers.get(sourceId).add(handler);
}

function offSourceDeleted(sourceId, handler) {
  const handlers = deleteHandlers.get(sourceId);
  if (!handlers) return;
  handlers.delete(handler);
  if (!handlers.size) deleteHandlers.delete(sourceId);
}

module.exports = { getApi, onSourceDeleted, offSourceDeleted };
