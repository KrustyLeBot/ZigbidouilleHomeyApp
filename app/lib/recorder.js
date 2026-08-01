'use strict';

// Rolling log of raw MIoT values. It is how the mid-clean recharge and the mop
// station cycle were decoded, and it stays on for the next unexplained
// behaviour: the fields that turn out to matter are never the ones the app
// already reads, so record more than is needed and diff afterwards.

const MAX_ENTRIES = 3000; // ~8h at one entry per 10s, bounded for Homey storage
const STORE_KEY = 'recharge_log';

// Wider than the app needs at runtime: these are the fields that plausibly
// encode job state. Recorded so the log is useful without a second session.
const WATCHED = [
  { did: 'status', siid: 2, piid: 1 },
  { did: 'fault', siid: 2, piid: 2 },
  { did: 's2p5', siid: 2, piid: 5 }, // minutes left on the mop drying cycle
  { did: 's2p6', siid: 2, piid: 6 }, // 0 mop fitted, 2 vacuum only
  { did: 's2p8', siid: 2, piid: 8 },
  { did: 'battery', siid: 3, piid: 1 },
  { did: 'charging', siid: 3, piid: 2 },
  { did: 's4p1', siid: 4, piid: 1 },
  { did: 's4p3', siid: 4, piid: 3 },
  { did: 's4p7', siid: 4, piid: 7 },
  { did: 's4p16', siid: 4, piid: 16 },
  { did: 's4p17', siid: 4, piid: 17 }, // 1 while docked to recharge mid-clean
  { did: 's4p18', siid: 4, piid: 18 },
  { did: 's4p20', siid: 4, piid: 20 },
  { did: 's4p25', siid: 4, piid: 25 }, // station: 1 washing, 2 drying, 3 driving home to wash
  { did: 's12p5', siid: 12, piid: 5 },
  // Replaces 7/9, which read 0 on every row of a week-long log and on four full
  // property sweeps - it is not the station field it was once taken for.
  { did: 's15p5', siid: 15, piid: 5 }, // 1 while the station empties the dust bin
];

class Recorder {
  constructor(device) {
    this.device = device;
    this.entries = device.getStoreValue(STORE_KEY) || [];
    this.lastSignature = null;
    this.dirty = false;
  }

  get enabled() {
    return this.device.getSetting('logging') !== false;
  }

  // Only records when something changed, so the log stays readable and small.
  record(values) {
    if (!this.enabled) return;

    const signature = JSON.stringify(values);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.entries.push({ t: Date.now(), ...values });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.dirty = true;
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await this.device.setStoreValue(STORE_KEY, this.entries).catch(() => {});
  }

  async clear() {
    this.entries = [];
    this.lastSignature = null;
    this.dirty = false;
    await this.device.setStoreValue(STORE_KEY, []).catch(() => {});
  }

  // CSV: opens in a spreadsheet, and is easy to paste back for analysis.
  toCsv() {
    const cols = ['t', ...WATCHED.map((w) => w.did)];
    const lines = [cols.join(',')];
    for (const e of this.entries) {
      lines.push(
        cols
          .map((c) => (c === 't' ? new Date(e.t).toISOString() : e[c] === undefined ? '' : e[c]))
          .join(',')
      );
    }
    return lines.join('\n');
  }

  get count() {
    return this.entries.length;
  }
}

module.exports = { Recorder, WATCHED };
