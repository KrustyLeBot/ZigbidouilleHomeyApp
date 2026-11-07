'use strict';

// Basic-auth check against an Apache-style htpasswd file (auth/htpasswd next
// to the compose file, mounted read-only).
//
// Supported hashes: bcrypt ($2y$ / $2a$ / $2b$ — what `htpasswd -B` writes) and
// {SHA}. MD5-crypt ($apr1$, plain `htpasswd` without -B) is refused with a
// clear log line rather than silently failing every login.
//
// The file is re-read when its mtime changes, so adding a user does not need a
// container restart. Successful checks are cached for a few minutes: bcrypt is
// deliberately slow, and Homey authenticates every API call.

const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const log = require('./log');

const CACHE_MS = 10 * 60 * 1000;

class Htpasswd {
  constructor(file) {
    this.file = file;
    this.mtimeMs = -1;
    this.users = new Map();
    this.cache = new Map();
    this.warned = new Set();
  }

  reload() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (err) {
      if (this.mtimeMs !== 0) log.error('auth', `cannot read ${this.file}: ${err.message} — every login will be refused`);
      this.mtimeMs = 0;
      this.users.clear();
      return;
    }
    if (stat.mtimeMs === this.mtimeMs) return;
    this.mtimeMs = stat.mtimeMs;
    this.users.clear();
    this.cache.clear();
    for (const raw of fs.readFileSync(this.file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      this.users.set(line.slice(0, idx), line.slice(idx + 1));
    }
    log.info('auth', `${this.users.size} user(s) loaded from ${this.file}`);
  }

  hasUsers() {
    this.reload();
    return this.users.size > 0;
  }

  verify(user, password) {
    this.reload();
    const hash = this.users.get(user);
    if (!hash || typeof password !== 'string') return false;

    const key = crypto.createHash('sha256').update(`${user}\0${password}\0${hash}`).digest('hex');
    const hit = this.cache.get(key);
    if (hit && hit > Date.now()) return true;

    let ok = false;
    if (/^\$2[aby]\$/.test(hash)) {
      // $2y$ is PHP/Apache's name for the same algorithm as $2a$/$2b$.
      ok = bcrypt.compareSync(password, hash.replace(/^\$2y\$/, '$2b$'));
    } else if (hash.startsWith('{SHA}')) {
      const expected = Buffer.from(hash.slice(5));
      const actual = Buffer.from(crypto.createHash('sha1').update(password).digest('base64'));
      ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } else if (!this.warned.has(user)) {
      this.warned.add(user);
      log.warn('auth', `user "${user}" has an unsupported hash — regenerate it with "htpasswd -nbB ${user} <password>"`);
    }

    if (ok) this.cache.set(key, Date.now() + CACHE_MS);
    return ok;
  }

  // Parses an "Authorization: Basic ..." header. Returns the user name or null.
  checkHeader(header) {
    const m = /^Basic\s+(.+)$/i.exec(header || '');
    if (!m) return null;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    const user = decoded.slice(0, idx);
    return this.verify(user, decoded.slice(idx + 1)) ? user : null;
  }
}

module.exports = { Htpasswd };
