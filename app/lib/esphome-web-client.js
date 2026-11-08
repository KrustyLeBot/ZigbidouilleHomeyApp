'use strict';

// Client for an ESPHome device's web_server (version 3), over its local HTTP
// API — no Home Assistant, no native-API protobuf, no extra dependency.
//
// What the firmware exposes (ESPHome 2026.x, web_server.cpp):
// - entities are addressed by NAME, not object_id: POST /switch/Auto Clean/turn_on,
//   POST /button/Level/press, POST /number/Clean After/set?value=2,
//   POST /text/Pet 1 Name/set?value=Cat%201;
// - GET /events is a Server-Sent Events stream: one `ping` (config) on connect,
//   then a `state` event per entity — every entity once on connect, then on each
//   change — with JSON `{ id: "<domain>/<name>", value, state }`;
// - Basic auth (the firmware sets `type: basic` explicitly).
//
// One instance per device. Protocol-neutral on purpose: any ESPHome device a
// future driver adopts can reuse it as is.

const http = require('http');

// Every network step gets a deadline (CLAUDE.md): a hung request logs nothing.
const REQUEST_TIMEOUT = 10000;
// The firmware sends `ping` every ~10-30 s on an idle stream; past this, the
// socket is presumed dead even if TCP has not noticed.
const IDLE_TIMEOUT = 90000;
const RECONNECT_MIN = 5000;
const RECONNECT_MAX = 60000;

class EsphomeWebClient {
  constructor({ host, username, password, onState, onConnected, onDisconnected, onError }) {
    this.host = host;
    this.auth = username ? `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}` : null;
    this.onState = onState || (() => {});
    this.onConnected = onConnected || (() => {});
    this.onDisconnected = onDisconnected || (() => {});
    this.onError = onError || (() => {});
    this.states = new Map(); // "<domain>/<name>" -> { value, state }
    this.req = null;
    this.connected = false;
    this.stopped = true;
    this.attempts = 0;
    this.idleTimer = null;
    this.reconnectTimer = null;
  }

  url(path) {
    return `http://${this.host}${path}`;
  }

  // POST /<domain>/<name>/<action>[?value=...]
  command(domain, name, action, value) {
    let path = `/${domain}/${encodeURIComponent(name)}/${action}`;
    if (value !== undefined) path += `?value=${encodeURIComponent(String(value))}`;
    return this.request('POST', path);
  }

  request(method, path) {
    return new Promise((resolve, reject) => {
      const req = http.request(this.url(path), {
        method,
        headers: { ...(this.auth ? { Authorization: this.auth } : {}), 'Content-Length': 0 },
        timeout: REQUEST_TIMEOUT,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 401) return reject(Object.assign(new Error('wrong username or password'), { status: 401 }));
          if (res.statusCode === 404) return reject(Object.assign(new Error(`no such entity: ${path}`), { status: 404 }));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(Object.assign(new Error(`HTTP ${res.statusCode}${body ? `: ${body.slice(0, 120)}` : ''}`), { status: res.statusCode }));
          }
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch (err) {
            // actions answer with an empty body or plain text: fine
          }
          return resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new Error(`no answer from ${this.host} within ${REQUEST_TIMEOUT / 1000} s`)));
      req.on('error', reject);
      req.end();
    });
  }

  // One-shot GET of an entity, used to validate a login during pairing.
  get(domain, name) {
    return this.request('GET', `/${domain}/${encodeURIComponent(name)}`);
  }

  // --- event stream ----------------------------------------------------------

  start() {
    this.stopped = false;
    if (!this.req) this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.req) this.req.destroy();
    this.req = null;
    this.setConnected(false);
  }

  setConnected(on) {
    if (this.connected === on) return;
    this.connected = on;
    try {
      (on ? this.onConnected : this.onDisconnected)();
    } catch (err) {
      this.onError(err);
    }
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.req) this.req.destroy(new Error('event stream silent, reconnecting'));
    }, IDLE_TIMEOUT);
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN * 2 ** this.attempts, RECONNECT_MAX);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  connect() {
    if (this.stopped || this.req) return;
    const req = http.get(this.url('/events'), {
      headers: { Accept: 'text/event-stream', ...(this.auth ? { Authorization: this.auth } : {}) },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      if (res.statusCode !== 200) {
        this.onError(new Error(res.statusCode === 401 ? 'event stream refused: wrong username or password' : `event stream refused: HTTP ${res.statusCode}`));
        res.resume();
        req.destroy();
        return;
      }
      req.setTimeout(0); // the stream is long-lived; the idle timer guards it instead
      this.attempts = 0;
      this.armIdle();
      this.setConnected(true);
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        this.armIdle();
        buffer += chunk;
        let sep;
        // Events end with a blank line; tolerate both \n\n and \r\n\r\n.
        while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + (buffer[sep] === '\r' ? 4 : 2));
          this.handleEvent(raw);
        }
        if (buffer.length > 65536) buffer = ''; // never let a broken stream grow without bound
      });
      res.on('end', () => req.destroy());
    });
    this.req = req;
    req.on('timeout', () => req.destroy(new Error(`no answer from ${this.host} within ${REQUEST_TIMEOUT / 1000} s`)));
    req.on('error', (err) => {
      if (this.connected || this.attempts <= 1) this.onError(err);
    });
    req.on('close', () => {
      if (this.req !== req) return;
      this.req = null;
      clearTimeout(this.idleTimer);
      this.setConnected(false);
      this.scheduleReconnect();
    });
  }

  handleEvent(raw) {
    let event = 'message';
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (event !== 'state' || !data.length) return;
    let msg;
    try {
      msg = JSON.parse(data.join('\n'));
    } catch (err) {
      return;
    }
    if (!msg || typeof msg.id !== 'string') return;
    const previous = this.states.get(msg.id);
    this.states.set(msg.id, { value: msg.value, state: msg.state });
    try {
      this.onState(msg.id, msg.value, msg.state, previous);
    } catch (err) {
      this.onError(err);
    }
  }

  value(id) {
    const s = this.states.get(id);
    return s ? s.value : undefined;
  }
}

module.exports = { EsphomeWebClient };
