'use strict';

// The MQTT broker the feeders connect to once mqtt.us.petlibro.com resolves to
// this host. Embedded (aedes) rather than a separate Mosquitto, so the whole
// bridge is one container and the "cloud" logic sees every message first-hand.
//
// Who may connect:
// - a feeder: client id = its serial number. Its own Petlibro username and
//   password are NOT checked — they are the same weak shared login for every
//   unit of a model (petlibro-local observed it on two fountains), there is no
//   way to learn them without capturing one first, and checking them would buy
//   nothing on a LAN. What a feeder can do is fenced instead: it may only
//   publish and subscribe under its own dl/<model>/<serial>/ prefix.
//   ALLOWED_SERIALS narrows it further to known units.
// - a human with an htpasswd login (MQTT Explorer, for debugging): full access.
//
// Restarting this broker makes the feeders reboot (petlibro-local saw it every
// time with Mosquitto): avoid updating the container around a meal time.

const net = require('net');
const { Aedes } = require('aedes');
const log = require('./log');

const SERIAL_RE = /^[A-Z]{2}[0-9]{2}[0-9A-Z]{6,40}$/;
const TOPIC_RE = /^dl\/([A-Z0-9]{4,12})\/([0-9A-Z]+)\/device\/([a-z]+)\/(post|sub)$/;

const warned = new Set();
function warnOnce(client, message) {
  const key = `${client && client.id}|${message}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn('mqtt', `${client && client.id}: ${message}`);
}

async function startBroker({ port, htpasswd, allowedSerials, onDeviceMessage, onDeviceConnect, onDeviceDisconnect }) {
  const isFeeder = (client) => client && client.petlibroSerial;

  const aedes = await Aedes.createBroker({
    authenticate(client, username, password, done) {
      const id = client.id || '';
      const pass = password ? password.toString() : '';
      if (username && htpasswd.verify(username, pass)) {
        client.petlibroAdmin = username;
        log.info('mqtt', `admin "${username}" connected (${id})`);
        return done(null, true);
      }
      if (SERIAL_RE.test(id) && (!allowedSerials.length || allowedSerials.includes(id))) {
        client.petlibroSerial = id;
        return done(null, true);
      }
      log.warn('mqtt', `refused client "${id}" (user "${username || ''}") — not a feeder serial${allowedSerials.length ? ' in ALLOWED_SERIALS' : ''} and no valid login`);
      const err = new Error('not authorized');
      err.returnCode = 5;
      return done(err, false);
    },

    authorizePublish(client, packet, done) {
      if (packet.topic.startsWith('$SYS/')) return done(new Error('$SYS is read-only'));
      if (client && client.petlibroAdmin) return done(null);
      // A feeder may never publish on a .../sub topic: that is how commands
      // reach a feeder, and one unit must not be able to drive another. Any
      // other dl/ topic is let through (an unexpected one is only logged, and
      // never acted on unless it is the feeder's own .../post — see 'publish'
      // below), because a refused publish makes aedes drop the connection and
      // the feeder would reconnect in a loop.
      if (!isFeeder(client) || !packet.topic.startsWith('dl/') || /\/sub$/.test(packet.topic)) {
        log.warn('mqtt', `refused publish by ${client && client.id} on ${packet.topic}`);
        return done(new Error('not authorized'));
      }
      const m = TOPIC_RE.exec(packet.topic);
      if (!m || m[2] !== client.petlibroSerial) warnOnce(client, `publishes on ${packet.topic} (ignored)`);
      return done(null);
    },

    authorizeSubscribe(client, sub, done) {
      if (client && client.petlibroAdmin) return done(null, sub);
      const parts = sub.topic.split('/');
      if (isFeeder(client) && parts[0] === 'dl') {
        // Its own topics: dl/<model>/<serial>/device/...
        if (parts[2] === client.petlibroSerial && parts[3] === 'device') return done(null, sub);
        // The model-wide channel every PLAF301 subscribes to on connect
        // (observed on fw 3.0.72: dl/PLAF301/device/broadcast/sub). Read-only
        // for feeders, and nothing publishes on it here.
        if (parts[2] === 'device' && parts[3] === 'broadcast') return done(null, sub);
      }
      // Anything else is negated (SUBACK 0x80), not failed: a failed
      // subscription makes aedes drop the client, and a feeder that is
      // dropped on every connect never gets as far as booting.
      warnOnce(client, `subscription to ${sub.topic} refused`);
      return done(null, null);
    },
  });

  aedes.on('client', (client) => {
    if (isFeeder(client)) onDeviceConnect(client.petlibroSerial);
  });
  aedes.on('clientDisconnect', (client) => {
    if (isFeeder(client)) onDeviceDisconnect(client.petlibroSerial);
  });
  aedes.on('clientError', (client, err) => {
    log.debug('mqtt', `client ${client && client.id} error: ${err.message}`);
  });
  aedes.on('publish', (packet, client) => {
    if (!isFeeder(client)) return;
    const m = TOPIC_RE.exec(packet.topic);
    // Only a feeder's own .../post is ever acted on.
    if (!m || m[2] !== client.petlibroSerial || m[4] !== 'post') return;
    let data;
    try {
      data = JSON.parse(packet.payload.toString('utf8'));
    } catch (err) {
      log.debug('mqtt', `non-JSON payload from ${client.id} on ${packet.topic}`);
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    onDeviceMessage({ serial: m[2], model: m[1], channel: m[3], topic: packet.topic, data });
  });

  const server = net.createServer(aedes.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  log.info('mqtt', `broker listening on ${port}`);

  return {
    publish(topic, payload) {
      aedes.publish({ cmd: 'publish', topic, payload: Buffer.from(JSON.stringify(payload)), qos: 0, retain: false }, () => {});
    },
    close: () => new Promise((resolve) => {
      server.close(() => aedes.close(resolve));
    }),
  };
}

module.exports = { startBroker, SERIAL_RE };
