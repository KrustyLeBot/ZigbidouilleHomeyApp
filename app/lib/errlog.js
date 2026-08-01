'use strict';

// Rolling log surfaced in the app settings page, so what happened during
// pairing / init can be read without the CLI.
//
// Persisted to Homey settings on purpose: a failed pairing often restarts the
// app, which would wipe an in-memory-only buffer and take the evidence with it.

const MAX = 200;
const SETTINGS_KEY = 'log';
const FLUSH_DELAY = 2000; // batch writes; pairing emits bursts of entries

class ErrLog {
  constructor() {
    this.entries = [];
    this.homey = null;
    this.flushTimer = null;
  }

  // Called once from App.onInit. Restores whatever survived the last run.
  //
  // APPENDS rather than replaces: drivers can initialise (and log) before
  // App.onInit runs, and overwriting here threw those fresh entries away — with
  // an empty stored array (after a Clear) that wiped the log to nothing, which
  // looked like logging was broken entirely.
  init(homey) {
    this.homey = homey;
    try {
      const stored = homey.settings.get(SETTINGS_KEY);
      if (Array.isArray(stored) && stored.length) {
        // Newest first, so anything already collected this run stays on top.
        this.entries = this.entries.concat(stored).slice(0, MAX);
      }
    } catch (err) {
      // Never let logging break startup.
    }
    this.scheduleFlush();
  }

  add(context, err) {
    const message = err && err.message ? err.message : String(err);
    this.push('error', context, message);
  }

  // Informational breadcrumb — same stream as errors so the ordering between
  // "what we tried" and "what failed" stays visible.
  info(context, message) {
    this.push('info', context, String(message));
  }

  push(level, context, message) {
    this.entries.unshift({ t: Date.now(), level, context, message });
    if (this.entries.length > MAX) this.entries.length = MAX;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (!this.homey || this.flushTimer) return;
    this.flushTimer = this.homey.setTimeout(() => {
      this.flushTimer = null;
      try {
        this.homey.settings.set(SETTINGS_KEY, this.entries);
      } catch (err) {
        // Persisting is best-effort; the in-memory copy still serves the page.
      }
    }, FLUSH_DELAY);
  }

  list() {
    return this.entries;
  }

  clear() {
    this.entries = [];
    if (this.homey) {
      try {
        this.homey.settings.set(SETTINGS_KEY, []);
      } catch (err) {
        // ignore
      }
    }
  }
}

// One shared instance for the whole app.
module.exports = new ErrLog();
