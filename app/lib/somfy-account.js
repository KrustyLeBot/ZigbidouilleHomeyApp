'use strict';

// One SomfyClient shared by the alarm device(s).
//
// Same shape as lib/imou-account.js: credentials live in the APP's settings
// (Settings -> Somfy tab), configured once before pairing, so pairing is a
// plain picker. Unlike Imou there is no separate app_id/app_secret to
// provision — the "account" IS a Somfy Protect login (the SECONDARY one
// created for this app, see .env.example / the settings page copy — never
// the primary login that also guards the front door in person).
//
// Tokens are persisted too (Settings, 'somfy_tokens'): the OAuth password
// grant is the equivalent of a fresh mobile-app install logging in from
// scratch, and doing that on every Homey restart is exactly the kind of
// pattern an anti-abuse system on someone else's API is likely to flag —
// worth avoiding when the refresh_token grant does the same job quietly.

const { SomfyClient } = require('./somfy-client');
const errlog = require('./errlog');

let client = null;
let signature = null;

function settingsSignature(homey) {
  return [homey.settings.get('somfy_email') || '', homey.settings.get('somfy_password') || ''].join('|');
}

// Returns null rather than throwing when nothing is configured yet, so a
// driver can show a clear "set it up in the app settings" message instead of
// an unhandled rejection during pairing or a poll.
function getClient(homey) {
  const username = homey.settings.get('somfy_email');
  const password = homey.settings.get('somfy_password');
  if (!username || !password) return null;

  const sig = settingsSignature(homey);
  if (!client || sig !== signature) {
    client = new SomfyClient({
      username,
      password,
      tokens: homey.settings.get('somfy_tokens') || null,
      onTokens: (tokens) => {
        try {
          homey.settings.set('somfy_tokens', tokens);
        } catch (err) {
          // best-effort persistence; the in-memory client still works this run
        }
      },
      // Only ever a genuine failure (see somfy-client.js's onError contract) —
      // a token refresh that quietly fixes itself never reaches this.
      onError: (err, { method, path }) => {
        errlog.add(`Somfy alarm: ${method} ${path}`, err);
      },
    });
    signature = sig;
  }
  return client;
}

module.exports = { getClient };
