'use strict';

// Live event stream from Somfy Protect, so the alarm's state reaches Homey the
// moment it changes instead of up to a poll interval later.
//
// Somfy's own phone app is driven by this socket, and the reference projects
// (Minims/SomfyProtect2MQTT) use exactly this endpoint and these event keys.
// It carries `security.level.change` — arm / disarm / night mode — and the
// alarm.* family, which is the entire read-only surface this app cares about,
// so polling drops to a slow safety net (see lib/somfy-alarm-device.js).
//
// Shared, not per-device: one socket serves every paired site, the same way
// lib/imou-account.js shares one batched status call. Devices subscribe by
// site_id.
//
// `ws` rather than a hand-rolled client: RFC 6455 framing, masking, ping/pong
// and close handshakes are a lot of surface to get subtly wrong, and Node only
// exposes a global WebSocket from v21 — unknown on this Homey's runtime.

const WebSocket = require('ws');
const errlog = require('./errlog');
const { getClient } = require('./somfy-account');

const HOST = 'wss://websocket.myfox.io/events/websocket';

// Values proven in production by SomfyProtect2MQTT rather than invented here.
const PING_INTERVAL = 15000;
const PING_TIMEOUT = 10000;
// The server goes quiet rather than closing when a connection has gone stale;
// a house with nothing happening is also quiet, so this is deliberately long.
const IDLE_CLOSE = 30 * 60 * 1000;

// Reconnect backoff. The reference client retries at a flat 5s; this backs off
// to a minute instead, because a failure that persists is usually Somfy being
// unhappy (rate limit, outage) and hammering an unofficial API through it is
// the wrong reflex.
const RECONNECT_MIN = 5000;
const RECONNECT_MAX = 60000;

const subscribers = new Map(); // siteId -> Set<handler>

let socket = null;
let homeyRef = null;
let pingTimer = null;
let idleTimer = null;
let reconnectTimer = null;
let attempts = 0;
let connected = false;
let stopped = false;

function subscribe(homey, siteId, handler) {
  homeyRef = homey;
  if (!subscribers.has(siteId)) subscribers.set(siteId, new Set());
  subscribers.get(siteId).add(handler);

  stopped = false;
  if (!socket) connect();
}

function unsubscribe(siteId, handler) {
  const set = subscribers.get(siteId);
  if (set) {
    set.delete(handler);
    if (!set.size) subscribers.delete(siteId);
  }
  // Last device gone (app shutting down, alarm removed): drop the socket
  // rather than leaving a connection open against someone else's server.
  if (!subscribers.size) close();
}

function dispatch(siteId, event) {
  const set = subscribers.get(siteId);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(event);
    } catch (err) {
      errlog.add('Somfy events: handler failed', err);
    }
  }
}

function clearTimers() {
  if (pingTimer) clearInterval(pingTimer);
  if (idleTimer) clearTimeout(idleTimer);
  pingTimer = null;
  idleTimer = null;
}

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Silence past the threshold means the socket is probably dead in a way
    // TCP has not noticed. Tear it down so the reconnect path runs.
    if (socket) socket.terminate();
  }, IDLE_CLOSE);
}

function scheduleReconnect() {
  if (stopped || reconnectTimer || !subscribers.size) return;
  const delay = Math.min(RECONNECT_MIN * 2 ** attempts, RECONNECT_MAX);
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function connect() {
  if (stopped || socket) return;

  const api = getClient(homeyRef);
  if (!api) return; // not configured yet; a later subscribe() will retry

  let token;
  try {
    token = await api.accessToken();
  } catch (err) {
    errlog.add('Somfy events: could not get a token', err);
    scheduleReconnect();
    return;
  }

  // NOTE: the token rides in the query string, so this URL is a credential.
  // Never log it — log HOST only. (Somfy's own app does the same; there is no
  // header-based alternative on this endpoint.)
  const ws = new WebSocket(`${HOST}?token=${encodeURIComponent(token)}`);
  socket = ws;

  ws.on('open', () => {
    attempts = 0;
    if (!connected) {
      connected = true;
      errlog.info('Somfy events', `live event stream connected (${HOST})`);
    }
    armIdleTimer();
    pingTimer = setInterval(() => {
      // ws answers a pong automatically; this only detects a server that has
      // stopped answering at all.
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      const deadline = setTimeout(() => ws.terminate(), PING_TIMEOUT);
      ws.once('pong', () => clearTimeout(deadline));
    }, PING_INTERVAL);
  });

  ws.on('message', (raw) => {
    armIdleTimer();
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      return; // not JSON: nothing actionable
    }
    handleMessage(message);
  });

  ws.on('error', (err) => {
    // Logged as an error because a stream that will not connect means the
    // alarm's state only refreshes at the slow fallback poll — worth seeing.
    errlog.add('Somfy events: socket error', err);
  });

  ws.on('close', () => {
    clearTimers();
    socket = null;
    if (connected) {
      connected = false;
      errlog.info('Somfy events', 'live event stream disconnected, reconnecting');
    }
    scheduleReconnect();
  });
}

async function handleMessage(message) {
  const key = message && message.key;
  if (!key) return;

  // The server rejects the token rather than closing the socket. Refreshing
  // and reconnecting is the documented recovery.
  if (key === 'websocket.error.token') {
    const api = getClient(homeyRef);
    if (api) await api.refresh().catch((err) => errlog.add('Somfy events: token refresh failed', err));
    if (socket) socket.terminate();
    return;
  }

  const siteId = message.site_id;
  if (!siteId) return;

  switch (key) {
    case 'security.level.change':
      dispatch(siteId, { type: 'security_level', level: message.security_level });
      break;

    // trespass = a sensor tripped while armed; panic = the SOS button.
    case 'alarm.trespass':
    case 'alarm.panic':
      dispatch(siteId, { type: 'alarm', triggered: true });
      break;

    case 'alarm.end':
      dispatch(siteId, { type: 'alarm', triggered: false });
      break;

    default:
      // Every other key (video.*, device.*, presence_*) belongs to hardware
      // this app does not adopt. Ignored rather than logged: the stream is
      // chatty and this is not a debugging tool.
      break;
  }
}

function close() {
  stopped = true;
  clearTimers();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  attempts = 0;
  connected = false;
  if (socket) {
    const ws = socket;
    socket = null;
    ws.removeAllListeners('close'); // do not let our own teardown schedule a reconnect
    ws.close();
  }
}

// Whether the live stream is currently up. Read by the device to decide
// whether the fallback poll is allowed to touch alarm_generic — see the
// comment there.
function isConnected() {
  return connected;
}

module.exports = { subscribe, unsubscribe, isConnected };
