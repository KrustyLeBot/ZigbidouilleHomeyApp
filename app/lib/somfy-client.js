'use strict';

// Somfy Protect (formerly Myfox) home alarm HTTP client.
//
// UNOFFICIAL. There is no public developer API for Somfy Protect — this talks
// to the same backend the phone app uses, reverse-engineered by the
// community (github.com/Minims/somfy-protect-api, github.com/Minims/
// SomfyProtect2MQTT, github.com/jay-d-tyler/homebridge-somfy-protect). It can
// break without notice if Somfy changes their app's auth. Field names below
// are what those projects document; NOT yet confirmed live against a real
// account — see probe/somfy/probe.js, which exists specifically to check
// them before the driver trusts any of this.
//
// A cloud device like the Imou cameras (lib/imou-client.js), for the same
// reason: the alarm's live status is nowhere but Somfy's servers.
//
// Auth is OAuth2 "password" grant using a Somfy Protect ACCOUNT's own email +
// password — not a per-app secret like Imou's appId/appSecret. Use a
// secondary account created for this purpose (Settings > add a user in the
// Somfy Protect app, role "guest", accept the invite once), never the primary
// login: same principle as every other credential in this app — dedicated,
// revocable, never the thing that also guards the front door in person.
//
// Guest is enough for the read-only use here, and limits what leaked
// credentials could do to the installation (no removing devices, no changing
// the site, no managing users). It does NOT stop them arming or disarming —
// Somfy lets every guest do that on purpose, since guests have to be able to
// switch the alarm off when they walk in. The reference projects suggest an
// "owner" secondary account because they also control the alarm; this one
// never does.

const https = require('https');
const querystring = require('querystring');

const SSO_HOST = 'sso.myfox.io';
const TOKEN_PATH = '/oauth/oauth/v2/token';
const API_HOST = 'api.myfox.io';
const REQUEST_TIMEOUT = 15000;

// The mobile app's own OAuth client credentials — not a secret of ours, this
// identifies "the official app" to Somfy's server, same string every
// installation of the app (and every project above) uses.
const CLIENT_ID = Buffer.from(
  'ODRlZGRmNDgtMmI4ZS0xMWU1LWIyYTUtMTI0Y2ZhYjI1NTk1XzQ3NWJ1cXJmOHY4a2d3b280Z293MDhna2tjMGNrODA0ODh3bzQ0czhvNDhzZzg0azQw',
  'base64',
).toString();
const CLIENT_SECRET = Buffer.from(
  'NGRzcWZudGlldTB3Y2t3d280MGt3ODQ4Z3c0bzBjOGs0b3djODBrNGdvMGNzMGs4NDQ=',
  'base64',
).toString();

// Confirmed live 2026-08-08: activating "night mode" in the Somfy Protect app
// turned security_level from 'disarmed' to 'partial' — that IS the night
// mode, not a guess. 'armed' is still only documented, not yet observed live.
// See docs/fingerprints.md.
const SECURITY_LEVELS = { DISARMED: 'disarmed', ARMED: 'armed', PARTIAL: 'partial' };

class SomfyError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'SomfyError';
    this.status = status;
    this.body = body;
  }
}

function request(host, path, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : body;
  const options = {
    host,
    port: 443,
    path,
    method,
    timeout: REQUEST_TIMEOUT,
    headers: { 'User-Agent': 'Somfy Protect', ...headers },
  };
  if (payload !== null) options.headers['Content-Length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        let parsed = raw;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (err) {
          // Some endpoints answer 204/empty; leave parsed as the raw string.
        }
        if (res.statusCode >= 400) {
          reject(new SomfyError(res.statusCode, parsed));
          return;
        }
        resolve(parsed);
      });
    });

    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timed out`)));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

class SomfyClient {
  // `tokens`, if supplied, resumes a previous session ({ access_token,
  // refresh_token, expires_at }) instead of re-authenticating with the
  // password grant — worth avoiding on every call, since repeatedly
  // "logging in" like a fresh device is exactly the pattern an anti-abuse
  // system on someone else's API is likely to flag.
  //
  // `onError`, if supplied, is called with (err, { method, path }) for a call
  // that ultimately FAILED — after the 401-retry above has already had its
  // shot, so a token refresh that quietly fixes itself is not reported as a
  // problem. This is deliberately the client's only logging hook: no
  // per-request success noise, because this file stays Homey-agnostic (the
  // probe copy has no errlog, no homey instance) — a device layer wires this
  // to errlog.add so a rate limit or a run of 5xx from this unofficial API
  // shows up in the app's Log tab instead of failing silently.
  constructor({ username, password, tokens = null, onTokens, onError } = {}) {
    this.username = username;
    this.password = password;
    this.tokens = tokens;
    this.onTokens = onTokens; // called with fresh tokens whenever they change, for persistence
    this.onError = onError;
  }

  async authenticate() {
    const body = querystring.stringify({
      grant_type: 'password',
      username: this.username,
      password: this.password,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    const data = await request(SSO_HOST, TOKEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    this.setTokens(data);
  }

  async refresh() {
    if (!this.tokens || !this.tokens.refresh_token) return this.authenticate();

    const body = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    try {
      const data = await request(SSO_HOST, TOKEN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      this.setTokens(data);
    } catch (err) {
      // A dead/expired refresh_token (e.g. 'invalid_grant', seen in the wild —
      // github.com/Minims/SomfyProtect2MQTT#180) falls back to a full login
      // rather than surfacing an auth error for something self-healing.
      await this.authenticate();
    }
  }

  setTokens(data) {
    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || (this.tokens && this.tokens.refresh_token),
      // expires_in is seconds; a margin avoids racing expiry mid-request.
      expires_at: Date.now() + (Number(data.expires_in) || 0) * 1000 - 60 * 1000,
    };
    if (this.onTokens) this.onTokens(this.tokens);
  }

  async accessToken() {
    if (!this.tokens) {
      await this.authenticate();
    } else if (Date.now() >= this.tokens.expires_at) {
      await this.refresh();
    }
    return this.tokens.access_token;
  }

  async call(method, path, body) {
    try {
      return await this.attempt(method, path, body);
    } catch (err) {
      if (this.onError) this.onError(err, { method, path });
      throw err;
    }
  }

  async attempt(method, path, body) {
    const token = await this.accessToken();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}` };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';

    try {
      return await request(API_HOST, path, { method, headers, body: payload });
    } catch (err) {
      // A token can be rejected by the API even though it looked unexpired
      // client-side (clock drift, server-side revocation). One retry after a
      // forced refresh, same reasoning as imou-client.js's TOKEN_ERRORS retry.
      // Not reported through onError: if this retry succeeds, nothing actually
      // went wrong from the caller's point of view.
      if (err instanceof SomfyError && err.status === 401) {
        await this.refresh();
        const retryToken = await this.accessToken();
        return request(API_HOST, path, {
          method,
          headers: { ...headers, Authorization: `Bearer ${retryToken}` },
          body: payload,
        });
      }
      throw err;
    }
  }

  // --- endpoints ---

  async getSites() {
    const data = await this.call('GET', '/v3/site');
    return data.items || data || [];
  }

  async getSite(siteId) {
    return this.call('GET', `/v3/site/${siteId}`);
  }

  async setSecurityLevel(siteId, level) {
    return this.call('PUT', `/v3/site/${siteId}/security`, { security_level: level });
  }

  // 'mode' per the reference clients: 'silent' or 'alarm'. Whether this is
  // really what the app's SOS button sends, vs a security_level of its own,
  // is exactly the thing probe/somfy/probe.js needs to settle before any
  // driver wires it to a capability.
  async triggerPanic(siteId, mode = 'alarm') {
    return this.call('POST', `/v3/site/${siteId}/panic`, { type: mode });
  }
}

module.exports = { SomfyClient, SomfyError, SECURITY_LEVELS };
