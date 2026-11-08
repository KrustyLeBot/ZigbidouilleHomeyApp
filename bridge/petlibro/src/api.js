'use strict';

// The Homey-facing side: a small JSON API plus one websocket that pushes every
// state change and event as it happens. Everything except /health requires a
// login from the htpasswd file (HTTP Basic, on the websocket upgrade too).
//
// Plain HTTP on the LAN, like the feeders' own MQTT: put it behind the NAS's
// reverse proxy if it must ever leave the local network — it should not.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const log = require('./log');

const MAX_BODY = 64 * 1024;
// The control page (src/web/index.html): read once, served at / behind the
// same login as the API, so the browser asks for it on the first visit.
const PAGE = fs.readFileSync(path.join(__dirname, 'web', 'index.html'));
const PING_MS = 30000;

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function startApi({ port, htpasswd, bridge, capture, version }) {
  const routes = [
    ['GET', /^\/api\/feeders$/, () => ({ feeders: bridge.list() })],
    ['GET', /^\/api\/feeders\/([^/]+)$/, (m) => bridge.get(m[1]).snapshot()],
    ['POST', /^\/api\/feeders\/([^/]+)\/feed$/, (m, body) => {
      bridge.get(m[1]).feed(body.portions);
      return { ok: true };
    }],
    ['POST', /^\/api\/feeders\/([^/]+)\/lid$/, (m, body) => {
      bridge.get(m[1]).setLid(body.open);
      return { ok: true };
    }],
    ['POST', /^\/api\/feeders\/([^/]+)\/settings$/, (m, body) => {
      bridge.get(m[1]).applySettings(body);
      return { ok: true };
    }],
    ['PUT', /^\/api\/feeders\/([^/]+)\/schedule$/, (m, body) => {
      const feeder = bridge.get(m[1]);
      feeder.setSchedule(body);
      return feeder.snapshot().schedule;
    }],
    ['POST', /^\/api\/feeders\/([^/]+)\/schedule\/paused$/, (m, body) => {
      const feeder = bridge.get(m[1]);
      feeder.setPaused(body.paused);
      return feeder.snapshot().schedule;
    }],
    ['POST', /^\/api\/feeders\/([^/]+)\/refill$/, (m) => {
      const feeder = bridge.get(m[1]);
      feeder.markRefilled();
      return feeder.snapshot().refill;
    }],
    ['POST', /^\/api\/feeders\/([^/]+)\/refill\/remind-now$/, (m) => {
      bridge.get(m[1]).remindNow();
      return { ok: true };
    }],
    ['PUT', /^\/api\/feeders\/([^/]+)\/refill-reminder$/, (m, body) => {
      const feeder = bridge.get(m[1]);
      feeder.setRefillReminder(body);
      return feeder.snapshot().refill;
    }],
    ['POST', /^\/api\/feeders\/([^/]+)\/display$/, async (m, body) => {
      const shown = await bridge.get(m[1]).showText(body.text);
      return { ok: true, text: shown };
    }],
    ['GET', /^\/api\/log$/, (m, body, url) => ({ entries: log.list(Number(url.searchParams.get('limit')) || 200) })],
    ['GET', /^\/api\/capture$/, (m, body, url) => ({
      lines: capture.read({ serial: url.searchParams.get('serial') || undefined, limit: Number(url.searchParams.get('limit')) || 500 }),
    })],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://bridge');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, version, feeders: bridge.list().map((f) => ({ serial: f.serial, online: f.online })) });
    }
    const user = htpasswd.checkHeader(req.headers.authorization);
    if (!user) {
      res.setHeader('WWW-Authenticate', 'Basic realm="petlibro-bridge"');
      return send(res, 401, { error: 'authentication required' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
      return res.end(PAGE);
    }
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (!m || req.method !== method) continue;
      try {
        const body = method === 'GET' ? {} : await readJson(req);
        return send(res, 200, await handler(m.map((x) => (x ? decodeURIComponent(x) : x)), body, url));
      } catch (err) {
        const status = err.status || (/unknown feeder/.test(err.message) ? 404 : 400);
        if (status >= 400) log.warn('api', `${req.method} ${url.pathname} by ${user}: ${err.message}`);
        return send(res, status, { error: err.message });
      }
    }
    return send(res, 404, { error: 'not found' });
  });

  // --- websocket: /api/events ---
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://bridge');
    const user = url.pathname === '/api/events' ? htpasswd.checkHeader(req.headers.authorization) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="petlibro-bridge"\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      ws.alive = true;
      ws.on('pong', () => {
        ws.alive = true;
      });
      log.info('api', `event stream opened by ${user} (${req.socket.remoteAddress})`);
      ws.on('close', () => log.info('api', `event stream closed by ${user}`));
      ws.send(JSON.stringify({ type: 'hello', version, feeders: bridge.list() }));
    });
  });

  const broadcast = (message) => {
    const json = JSON.stringify(message);
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(json);
  };
  bridge.on('state', (snapshot) => broadcast({ type: 'state', feeder: snapshot }));
  bridge.on('event', (serial, event) => broadcast({ type: 'event', serial, event }));

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, PING_MS);
  pinger.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      log.info('api', `API listening on ${port}`);
      resolve({ close: () => new Promise((r) => { clearInterval(pinger); wss.close(); server.close(() => r()); }) });
    });
  });
}

module.exports = { startApi };
