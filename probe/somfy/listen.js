'use strict';

// What this answers: what the live event stream actually sends when the alarm
// changes state, so lib/somfy-events.js maps real keys rather than keys copied
// out of someone else's source.
//
// Confirmed with this script: an expired token is rejected with a
// `websocket.error.token` message AND close code 3000 "unauthorized" — the
// server does not silently accept a stale token, which is what makes the
// refresh-and-reconnect path in lib/somfy-events.js necessary rather than
// theoretical.
//
//   node listen.js            listen until Ctrl-C
//   node listen.js 300        listen for 300 seconds, then exit
//
// Prints every message. Uses (and refreshes) the token cache in .token.json,
// same as probe.js. Requires `ws` — installed in ../../app/node_modules, which
// this reuses rather than adding a second copy.

const path = require('path');
const fs = require('fs');
const WebSocket = require(path.join(__dirname, '..', '..', 'app', 'node_modules', 'ws'));
const { SomfyClient } = require('./somfy-client');
const { requireVars } = require('../env');

const HOST = 'wss://websocket.myfox.io/events/websocket';
const TOKEN_FILE = path.join(__dirname, '.token.json');

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (err) {
    return null;
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);

async function main() {
  const seconds = Number(process.argv[2]) || 0;
  const [username, password] = requireVars(['SOMFY_EMAIL', 'SOMFY_PASSWORD']);

  const api = new SomfyClient({
    username,
    password,
    tokens: loadTokens(),
    onTokens: (tokens) => fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2)),
  });

  // Always through accessToken() so an expired cache is refreshed first — the
  // websocket rejects a stale token outright rather than tolerating it.
  const token = await api.accessToken();

  // The token is in the query string, so this URL is a credential: printed
  // host-only, never in full.
  console.log(`${stamp()} connecting to ${HOST}`);
  const ws = new WebSocket(`${HOST}?token=${encodeURIComponent(token)}`);

  ws.on('open', () => console.log(`${stamp()} OPEN`));

  ws.on('message', (raw) => {
    const text = raw.toString();
    let message;
    try {
      message = JSON.parse(text);
    } catch (err) {
      console.log(`${stamp()} TEXT  ${text.slice(0, 200)}`);
      return;
    }
    // Full message, not a summary: the point of this script is to discover
    // fields that were not expected.
    console.log(`${stamp()} ${message.key}\n${JSON.stringify(message, null, 2)}`);
  });

  ws.on('error', (err) => console.log(`${stamp()} ERROR ${err.message}`));
  ws.on('close', (code, reason) => {
    console.log(`${stamp()} CLOSE ${code} ${reason.toString()}`);
    process.exit(0);
  });

  if (seconds) setTimeout(() => ws.close(), seconds * 1000);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
