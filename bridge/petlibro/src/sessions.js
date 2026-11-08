'use strict';

// Browser sessions for the control page.
//
// The API keeps HTTP Basic (Homey, curl, scripts send it up front). A browser
// gets a real login form instead — the native Basic popup is ugly, cannot be
// filled by password managers and has no way to log out — then a session
// cookie: HttpOnly (no script can read it), SameSite=Strict (another site
// cannot make the browser use it, which is what keeps the POST routes safe
// from cross-site requests).
//
// Sessions live in memory: a container restart logs the browser out, which a
// password manager makes a one-click affair, and nothing secret lands on disk.

const crypto = require('crypto');

const COOKIE = 'plb_session';
const MAX_AGE_S = 30 * 24 * 3600;
// Failed logins per client address before it has to wait: enough for typos,
// too few for guessing.
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

class Sessions {
  constructor() {
    this.sessions = new Map(); // token -> { user, expires }
    this.failures = new Map(); // address -> { count, since }
  }

  create(user) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { user, expires: Date.now() + MAX_AGE_S * 1000 });
    return token;
  }

  // The user behind a request's session cookie, or null.
  user(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s.user;
  }

  destroy(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) this.sessions.delete(token);
  }

  cookie(token, req) {
    return serialize(token, MAX_AGE_S, req);
  }

  clearCookie(req) {
    return serialize('', 0, req);
  }

  blocked(address) {
    const f = this.failures.get(address);
    if (!f) return false;
    if (Date.now() - f.since > FAILURE_WINDOW_MS) {
      this.failures.delete(address);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }

  failed(address) {
    const f = this.failures.get(address);
    if (!f || Date.now() - f.since > FAILURE_WINDOW_MS) this.failures.set(address, { count: 1, since: Date.now() });
    else f.count += 1;
  }

  succeeded(address) {
    this.failures.delete(address);
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Secure only when the page was reached over HTTPS (a reverse proxy or the
// Cloudflare tunnel says so): on the plain-HTTP LAN a Secure cookie would
// never be sent back.
function serialize(value, maxAge, req) {
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}

module.exports = { Sessions };
