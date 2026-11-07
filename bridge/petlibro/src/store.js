'use strict';

// Everything the bridge must remember across a restart, in one JSON file on
// the /data volume: per feeder, the schedule (it is the source of truth for
// meals — the feeder asks for it after every boot) and the settings last
// asked for. Live readings are NOT persisted: they are re-read from the feeder
// on reconnect, and a remembered battery level from yesterday would only lie.
//
// Written atomically (temp file + rename) so a container killed mid-write
// cannot leave a half file that loses every schedule at the next start.

const fs = require('fs');
const path = require('path');
const log = require('./log');

const STORE_VERSION = 1;
const SAVE_DELAY = 500;

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.data = { version: STORE_VERSION, feeders: {} };
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && parsed.version === STORE_VERSION && parsed.feeders) this.data = parsed;
      else log.warn('store', `ignoring ${this.file}: unknown version ${parsed && parsed.version}`);
    } catch (err) {
      if (err.code !== 'ENOENT') log.error('store', `cannot read ${this.file}: ${err.message}`);
    }
  }

  feeder(serial) {
    if (!this.data.feeders[serial]) this.data.feeders[serial] = {};
    return this.data.feeders[serial];
  }

  serials() {
    return Object.keys(this.data.feeders);
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SAVE_DELAY);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error('store', `cannot write ${this.file}: ${err.message}`);
    }
  }
}

module.exports = { Store };
