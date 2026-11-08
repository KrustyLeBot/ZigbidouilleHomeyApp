'use strict';

// The Homey-facing side: a small JSON API plus one websocket that pushes every
// state change and event as it happens. Everything except /health and the
// login page requires a login from the htpasswd file, given either way:
// - HTTP Basic, sent up front (Homey, curl, scripts) — API and websocket;
// - a session cookie from the /login form (a browser), see sessions.js.
// No WWW-Authenticate header is ever sent, so a browser never shows its native
// Basic popup: the page goes to /login instead.
//
// Plain HTTP on the LAN, like the feeders' own MQTT: put it behind the NAS's
// reverse proxy if it must ever leave the local network — it should not.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const log = require('./log');
const { Sessions } = require('./sessions');

const MAX_BODY = 64 * 1024;
// The control page and its login form, read once.
const PAGE = fs.readFileSync(path.join(__dirname, 'web', 'index.html'));
const LOGIN_PAGE = fs.readFileSync(path.join(__dirname, 'web', 'login.html'), 'utf8');
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' };
const PING_MS = 30000;

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function loginPage(res, error) {
  const html = LOGIN_PAGE.replace('<!--ERROR-->', error || '');
  res.writeHead(error ? 401 : 200, HTML_HEADERS);
  res.end(html);
}

function readBody(req) {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

// Behind a reverse proxy every request comes from the proxy: rate-limit on the
// address it forwards instead.
function clientAddress(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

function startApi({ port, htpasswd, bridge, capture, version }) {
  const sessions = new Sessions();
  const authenticate = (req) => htpasswd.checkHeader(req.headers.authorization) || sessions.user(req);

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
    if (url.pathname === '/login') {
      if (req.method === 'GET') {
        return sessions.user(req) ? redirect(res, '/') : loginPage(res);
      }
      if (req.method === 'POST') {
        const address = clientAddress(req);
        if (sessions.blocked(address)) {
          log.warn('api', `login refused from ${address}: too many failures`);
          return loginPage(res, 'Trop d’essais. Réessayez dans quelques minutes.');
        }
        let form;
        try {
          form = new URLSearchParams(await readBody(req));
        } catch (err) {
          return loginPage(res, 'Requête invalide.');
        }
        const username = form.get('username') || '';
        if (!htpasswd.verify(username, form.get('password') || '')) {
          sessions.failed(address);
          log.warn('api', `failed login for "${username.slice(0, 64)}" from ${address}`);
          return loginPage(res, 'Identifiant ou mot de passe incorrect.');
        }
        sessions.succeeded(address);
        log.info('api', `${username} logged in from ${address}`);
        return redirect(res, '/', { 'Set-Cookie': sessions.cookie(sessions.create(username), req) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      sessions.destroy(req);
      return redirect(res, '/login', { 'Set-Cookie': sessions.clearCookie(req) });
    }
    const user = authenticate(req);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!user) return redirect(res, '/login');
      res.writeHead(200, HTML_HEADERS);
      return res.end(PAGE);
    }
    if (!user) return send(res, 401, { error: 'authentication required' });
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
    const user = url.pathname === '/api/events' ? authenticate(req) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
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
