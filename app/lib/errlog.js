'use strict';

// Small in-memory ring of recent errors, surfaced in the settings page so
// problems (like a capability write or a cluster bind failing) are visible
// without the CLI.

const MAX = 50;

class ErrLog {
  constructor() {
    this.entries = [];
  }

  add(context, err) {
    const message = err && err.message ? err.message : String(err);
    this.entries.unshift({ t: Date.now(), context, message });
    if (this.entries.length > MAX) this.entries.length = MAX;
  }

  list() {
    return this.entries;
  }

  clear() {
    this.entries = [];
  }
}

// One shared instance for the whole app.
module.exports = new ErrLog();
