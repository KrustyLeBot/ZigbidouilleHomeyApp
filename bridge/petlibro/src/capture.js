'use strict';

// Raw MQTT trace: every message to and from a feeder, one JSON line each, on
// the /data volume. The petlibro counterpart of the vacuums' miIO CSV — the
// tool for decoding whatever the protocol notes do not cover yet (a setting
// changed in the Petlibro app before it is uninstalled, an unknown errorCode).
//
// Kept apart from the log on purpose: dense machine data meant to be exported
// and diffed, not read line by line. Two files of MAX_BYTES each, rotated.
// Wi-Fi credentials, should a feeder ever send them, are redacted before the
// line is written.

const fs = require('fs');
const path = require('path');
const log = require('./log');

const MAX_BYTES = 5 * 1024 * 1024;
const REDACT = new Set(['wifiSsid', 'wifiPassword', 'password', 'passwd']);

class Capture {
  constructor(dir) {
    this.file = path.join(dir, 'capture.jsonl');
    this.previous = path.join(dir, 'capture.1.jsonl');
    try {
      this.size = fs.statSync(this.file).size;
    } catch (err) {
      this.size = 0;
    }
  }

  record(direction, topic, payload) {
    let body = payload;
    if (body && typeof body === 'object') {
      body = { ...body };
      for (const key of Object.keys(body)) if (REDACT.has(key)) body[key] = '<redacted>';
    }
    const line = `${JSON.stringify({ t: Date.now(), dir: direction, topic, payload: body })}\n`;
    try {
      if (this.size + line.length > MAX_BYTES) {
        fs.renameSync(this.file, this.previous);
        this.size = 0;
      }
      fs.appendFileSync(this.file, line);
      this.size += line.length;
    } catch (err) {
      if (!this.failed) log.error('capture', `cannot write ${this.file}: ${err.message}`);
      this.failed = true;
    }
  }

  // Newest last, optionally only one feeder's lines.
  read({ serial, limit = 500 } = {}) {
    const lines = [];
    for (const file of [this.previous, this.file]) {
      try {
        lines.push(...fs.readFileSync(file, 'utf8').split('\n').filter(Boolean));
      } catch (err) {
        // a missing rotation file is the normal case
      }
    }
    const wanted = serial ? lines.filter((l) => l.includes(`/${serial}/`)) : lines;
    return wanted.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        return { raw: l };
      }
    });
  }
}

module.exports = { Capture };
