'use strict';

// petlibro-bridge: stands in for the Petlibro cloud on the LAN.
//
//   feeders --MQTT 1883--> [broker + one Feeder per serial] <--HTTP/WS 8484-- Homey
//
// The feeders reach it because mqtt.us.petlibro.com resolves to this host (a
// DNS rewrite, AdGuard Home here) and the internet is blocked for them. See
// README.md, "Petlibro One RFID".

const path = require('path');
const EventEmitter = require('events');
const log = require('./log');
const tz = require('./tz');
const { Store } = require('./store');
const { Capture } = require('./capture');
const { Htpasswd } = require('./htpasswd');
const { Feeder } = require('./feeder');
const { startBroker } = require('./broker');
const { startApi } = require('./api');
const { version } = require('../package.json');

const config = {
  mqttPort: Number(process.env.MQTT_PORT) || 1883,
  httpPort: Number(process.env.HTTP_PORT) || 8484,
  dataDir: process.env.DATA_DIR || '/data',
  htpasswdFile: process.env.HTPASSWD_FILE || '/auth/htpasswd',
  timezone: process.env.TZ || 'Europe/Paris',
  allowedSerials: (process.env.ALLOWED_SERIALS || '').split(',').map((s) => s.trim()).filter(Boolean),
};

class Bridge extends EventEmitter {
  constructor({ store, capture, timezone }) {
    super();
    this.store = store;
    this.capture = capture;
    this.timezone = timezone;
    this.feeders = new Map();
    this.broker = null;
    // Feeders with a schedule are known before they reconnect, so Homey can
    // still list them (offline) after a container restart.
    for (const serial of store.serials()) this.feeder(serial);
  }

  feeder(serial) {
    let f = this.feeders.get(serial);
    if (!f) {
      f = new Feeder({
        serial,
        store: this.store,
        defaultTimezone: this.timezone,
        publish: (topic, payload) => {
          this.capture.record('out', topic, payload);
          if (this.broker) this.broker.publish(topic, payload);
        },
      });
      f.on('state', (snapshot) => this.emit('state', snapshot));
      f.on('event', (event) => this.emit('event', serial, event));
      this.feeders.set(serial, f);
      this.store.feeder(serial);
      this.store.save();
    }
    return f;
  }

  get(serial) {
    const f = this.feeders.get(serial);
    if (!f) throw new Error(`unknown feeder ${serial}`);
    return f;
  }

  list() {
    return [...this.feeders.values()].map((f) => f.snapshot());
  }
}

async function main() {
  if (!tz.isValidTimezone(config.timezone)) {
    log.error('bridge', `TZ="${config.timezone}" is not a valid IANA zone, using Europe/Paris`);
    config.timezone = 'Europe/Paris';
  }
  const store = new Store(config.dataDir);
  const capture = new Capture(config.dataDir);
  const htpasswd = new Htpasswd(config.htpasswdFile);
  if (!htpasswd.hasUsers()) {
    log.error('bridge', `no user in ${config.htpasswdFile}: the API will refuse every request until one is added`);
  }

  const bridge = new Bridge({ store, capture, timezone: config.timezone });

  bridge.broker = await startBroker({
    port: config.mqttPort,
    htpasswd,
    allowedSerials: config.allowedSerials,
    onDeviceConnect: (serial) => log.info(`Feeder ${serial.slice(-4)}`, `MQTT connected (${serial})`),
    onDeviceDisconnect: (serial) => log.info(`Feeder ${serial.slice(-4)}`, 'MQTT disconnected'),
    onDeviceMessage: ({ serial, model, channel, topic, data }) => {
      capture.record('in', topic, data);
      log.debug(`Feeder ${serial.slice(-4)}`, `${channel} ${data.cmd || '?'}`);
      if (model !== 'PLAF301') {
        // Only the One RFID is modelled. Anything else is kept in the capture
        // and otherwise left alone — answering it with PLAF301 assumptions
        // could do real harm (the Polar's plate motor, for one).
        log.warn('bridge', `${serial} talks as ${model}, which this bridge does not handle — ignored`);
        return;
      }
      try {
        bridge.feeder(serial).handle(channel, data, model);
      } catch (err) {
        log.error(`Feeder ${serial.slice(-4)}`, `handling ${data.cmd}: ${err.message}`);
      }
    },
  });

  const api = await startApi({ port: config.httpPort, htpasswd, bridge, capture, version });

  const ticker = setInterval(() => {
    for (const f of bridge.feeders.values()) {
      try {
        f.tick();
      } catch (err) {
        log.error(f.name(), `tick: ${err.message}`);
      }
    }
  }, 60000);

  log.info('bridge', `petlibro-bridge ${version} up — default timezone ${config.timezone}, data in ${path.resolve(config.dataDir)}`);

  const stop = async (signal) => {
    log.info('bridge', `${signal}, stopping`);
    clearInterval(ticker);
    store.flush();
    await Promise.race([Promise.all([api.close(), bridge.broker.close()]), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    log.error('bridge', `fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { Bridge, main };
