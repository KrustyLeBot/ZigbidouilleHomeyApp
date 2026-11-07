'use strict';

// The connection to petlibro-bridge (bridge/petlibro in this repo), shared by
// every Petlibro feeder device: one websocket for live state and events, plain
// HTTP for commands. Same shape as lib/somfy-account.js + lib/somfy-events.js:
// credentials live in the APP settings (Settings -> Petlibro), so pairing is a
// picker, and one socket serves every device, which subscribes by serial.
//
// The bridge, not Homey, plays the Petlibro cloud for the feeders (time sync,
// acks, re-sending the meal plans after a reboot). That is deliberate: meals
// must keep being served while Homey restarts or updates. Homey only reads
// state, sends commands and edits the schedule.

const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const errlog = require('./errlog');

// Every network step gets a deadline — a hung request otherwise produces no
// log line at all, indistinguishable from code that never ran (CLAUDE.md).
const REQUEST_TIMEOUT = 10000;
const RECONNECT_MIN = 5000;
const RECONNECT_MAX = 60000;
// The bridge pings every 30 s; silence well past that means a dead socket TCP
// has not noticed yet.
const IDLE_CLOSE = 90000;

const subscribers = new Map(); // serial -> Set<handler>
const latest = new Map(); // serial -> last snapshot received

let homeyRef = null;
let socket = null;
let connected = false;
let reconnectTimer = null;
let idleTimer = null;
let attempts = 0;
let stopped = false;

function config(homey) {
  const raw = (homey.settings.get('petlibro_url') || '').trim().replace(/\/+$/, '');
  const username = homey.settings.get('petlibro_username') || '';
  const password = homey.settings.get('petlibro_password') || '';
  if (!raw || !username || !password) return null;
  const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return { url, username, password };
}

function authHeader(cfg) {
  return `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
}

// JSON request to the bridge. Rejects with the bridge's own error message when
// it gives one ("feeder offline", "portions must be 1..10"), so a flow card or
// a settings save shows something a human can act on.
function request(homey, method, path, body) {
  const cfg = config(homey);
  if (!cfg) return Promise.reject(new Error(homey.__('petlibro.not_configured')));
  const url = new URL(path, `${cfg.url}/`);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      headers: {
        Authorization: authHeader(cfg),
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          // not JSON: handled by the status check below
        }
        if (res.statusCode === 401) return reject(new Error(homey.__('petlibro.bad_login')));
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error((data && data.error) || `HTTP ${res.statusCode}`));
        }
        return resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from the bridge within ${REQUEST_TIMEOUT / 1000} s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- live stream -------------------------------------------------------------

function subscribe(homey, serial, handler) {
  homeyRef = homey;
  if (!subscribers.has(serial)) subscribers.set(serial, new Set());
  subscribers.get(serial).add(handler);
  stopped = false;
  if (!socket) connect();
  // Replay what is already known, so a device created while the socket is up
  // does not wait for the next change to show anything.
  if (latest.has(serial)) {
    try {
      handler({ type: 'state', feeder: latest.get(serial) });
    } catch (err) {
      errlog.add('Petlibro: handler failed', err);
    }
  }
}

function unsubscribe(serial, handler) {
  const set = subscribers.get(serial);
  if (set) {
    set.delete(handler);
    if (!set.size) subscribers.delete(serial);
  }
  if (!subscribers.size) close();
}

function dispatch(serial, message) {
  const set = subscribers.get(serial);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(message);
    } catch (err) {
      errlog.add('Petlibro: handler failed', err);
    }
  }
}

function dispatchAll(message) {
  for (const serial of subscribers.keys()) dispatch(serial, message);
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
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

function connect() {
  if (stopped || socket || !homeyRef) return;
  const cfg = config(homeyRef);
  if (!cfg) return; // not configured: a later subscribe() or settings save retries

  const wsUrl = `${cfg.url.replace(/^http/i, 'ws')}/api/events`;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: authHeader(cfg) }, handshakeTimeout: REQUEST_TIMEOUT });
  socket = ws;

  ws.on('open', () => {
    attempts = 0;
    armIdle();
    if (!connected) {
      connected = true;
      errlog.info('Petlibro bridge', `event stream connected (${wsUrl})`);
      dispatchAll({ type: 'bridge', connected: true });
    }
  });

  ws.on('ping', armIdle);

  ws.on('message', (raw) => {
    armIdle();
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }
    if (message.type === 'hello') {
      for (const feeder of message.feeders || []) {
        latest.set(feeder.serial, feeder);
        dispatch(feeder.serial, { type: 'state', feeder });
      }
    } else if (message.type === 'state' && message.feeder) {
      latest.set(message.feeder.serial, message.feeder);
      dispatch(message.feeder.serial, message);
    } else if (message.type === 'event' && message.serial) {
      dispatch(message.serial, message);
    }
  });

  ws.on('unexpected-response', (req, res) => {
    errlog.add('Petlibro bridge', new Error(res.statusCode === 401
      ? 'event stream refused: wrong username or password (Settings -> Petlibro)'
      : `event stream refused: HTTP ${res.statusCode}`));
  });

  ws.on('error', (err) => {
    // Logged once per outage, not once per retry: a NAS that is off for an
    // hour would otherwise fill the log with the same line.
    if (connected || attempts <= 1) errlog.add('Petlibro bridge: event stream', err);
  });

  ws.on('close', () => {
    // A socket replaced by reconnect() closes late: it must not clear the new one.
    if (socket !== ws) return;
    if (idleTimer) clearTimeout(idleTimer);
    socket = null;
    if (connected) {
      connected = false;
      errlog.info('Petlibro bridge', 'event stream disconnected, reconnecting');
      dispatchAll({ type: 'bridge', connected: false });
    }
    scheduleReconnect();
  });
}

function close() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (idleTimer) clearTimeout(idleTimer);
  reconnectTimer = null;
  if (socket) socket.terminate();
  socket = null;
  connected = false;
}

// Settings changed: drop the socket and come back with the new credentials.
function reconnect() {
  if (socket) socket.terminate();
  socket = null;
  connected = false;
  attempts = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopped = false;
  if (subscribers.size) connect();
}

function isConnected() {
  return connected;
}

module.exports = {
  request,
  subscribe,
  unsubscribe,
  reconnect,
  isConnected,
  isConfigured: (homey) => Boolean(config(homey)),
};
