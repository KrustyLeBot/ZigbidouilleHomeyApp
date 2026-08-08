'use strict';

// One ImouClient shared by every Imou camera device.
//
// The account's free tier is 30,000 API requests per MONTH — for the whole
// developer account, shared by every camera, not per device and not per day.
// At 5 cameras that is roughly 200/day on average with zero margin, which is
// why every call here is worth avoiding: a fresh client per device per poll
// would mean paying accessToken() needlessly (tokens last 3 days and must be
// reused), and polling each camera's online state individually is the other
// big one — see the registry below. Credentials live in the APP's settings
// (Homey.settings, not a device setting): the user configures them once, in
// the app settings page, before pairing any camera — that is what lets
// pairing show a picker instead of asking for a secret per device.

const { ImouClient } = require('./imou-client');

let client = null;
let signature = null;

function settingsSignature(homey) {
  return [
    homey.settings.get('imou_app_id') || '',
    homey.settings.get('imou_app_secret') || '',
    homey.settings.get('imou_host') || '',
  ].join('|');
}

// Returns null rather than throwing when nothing is configured yet, so a
// driver can show a clear "set it up in the app settings" message instead of
// an unhandled rejection during pairing or a poll.
function getClient(homey) {
  const appId = homey.settings.get('imou_app_id');
  const appSecret = homey.settings.get('imou_app_secret');
  if (!appId || !appSecret) return null;

  const sig = settingsSignature(homey);
  if (!client || sig !== signature) {
    client = new ImouClient({ appId, appSecret, host: homey.settings.get('imou_host') || undefined });
    signature = sig;
  }
  return client;
}

// Called after a successful discoverHost() so the result is remembered and
// every later call skips straight to the right data centre.
function rememberHost(homey, host) {
  homey.settings.set('imou_host', host);
  signature = null; // force getClient() to rebuild with the new host
}

// --- shared online-status cache ---
//
// Every camera device polls itself on its own timer, so with 5 cameras a
// naive "check online, then read switches" design pays for 5 separate
// deviceOnline calls a cycle for information that comes back in ONE
// deviceBaseDetailList call covering up to 8 devices. This is what makes that
// possible: devices register themselves here at onInit, and whichever camera
// polls first each cycle pays for a fresh batched lookup that the rest reuse.
//
// CACHE_TTL is short on purpose — well under any sane poll_interval — so it
// exists only to coalesce calls that land within the same moment (all 5
// cameras created at the same default interval tend to fire close together),
// not to serve a stale answer to a camera whose own interval has been turned
// down. A single in-flight promise stops concurrent callers from each
// starting their own request while one is already on the wire.
const CACHE_TTL = 90 * 1000;
const registeredCameras = new Set();
let statusCache = null; // { map, fetchedAt }
let statusInFlight = null;

function registerCamera(deviceId) {
  registeredCameras.add(deviceId);
}

function unregisterCamera(deviceId) {
  registeredCameras.delete(deviceId);
}

// Resolves to a Map<deviceId, online:boolean> covering every registered
// camera. Never throws away a previous good cache on failure — a transient
// error surfaces to the caller (who already knows how to treat it as a poll
// failure), while the next call gets to try again rather than being poisoned
// by a cached rejection.
async function getOnlineMap(homey) {
  const now = Date.now();
  if (statusCache && now - statusCache.fetchedAt < CACHE_TTL) return statusCache.map;
  if (statusInFlight) return statusInFlight;

  const api = getClient(homey);
  if (!api) return new Map();

  statusInFlight = api
    .deviceStatusList([...registeredCameras])
    .then((map) => {
      statusCache = { map, fetchedAt: Date.now() };
      return map;
    })
    .finally(() => {
      statusInFlight = null;
    });

  return statusInFlight;
}

module.exports = { getClient, rememberHost, registerCamera, unregisterCamera, getOnlineMap };
