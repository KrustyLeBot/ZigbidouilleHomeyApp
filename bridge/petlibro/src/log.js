'use strict';

// One log for the whole bridge: printed to stdout (what `docker logs` shows)
// and kept in a ring buffer the Homey app can read over the API, so the
// bridge's side of a problem is visible from the app's own Log tab without
// shelling into the NAS.
//
// Same line shape as the Homey app's log — `Context: what happened` — so the
// per-device filter there keeps working on lines that came from here.

const MAX = 500;
const entries = [];
const listeners = new Set();
let verbose = /^debug$/i.test(process.env.LOG_LEVEL || '');

function push(level, context, message) {
  const entry = { t: Date.now(), level, context, message: String(message) };
  entries.unshift(entry);
  if (entries.length > MAX) entries.length = MAX;
  const line = `${new Date(entry.t).toISOString()} ${level.toUpperCase().padEnd(5)} ${context}: ${entry.message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch (err) {
      // a broken listener must never take the log down with it
    }
  }
}

module.exports = {
  info: (context, message) => push('info', context, message),
  warn: (context, message) => push('warn', context, message),
  error: (context, err) => push('error', context, err && err.message ? err.message : err),
  // Dropped unless LOG_LEVEL=debug: the per-message breadcrumbs, which would
  // otherwise bury the lines that matter at one heartbeat per feeder per 90 s.
  debug: (context, message) => {
    if (verbose) push('debug', context, message);
  },
  setVerbose: (on) => {
    verbose = Boolean(on);
  },
  isVerbose: () => verbose,
  list: (limit = MAX) => entries.slice(0, limit),
  onEntry: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
