'use strict';

// What this answers, before any driver trusts lib/somfy-client.js:
//
//   - Does the reverse-engineered OAuth login still work?
//   - What are the site's REAL security_level values, and which one is the
//     app's "night" mode (the client only documents disarmed/armed/partial —
//     'partial' is a guess for "night", unconfirmed)?
//   - Is SOS a security_level of its own, or the separate /panic endpoint?
//   - What does the full site payload look like (device list, battery,
//     anything else worth a capability)?
//
// Nothing here is assumed correct until seen in this output.
//
//   node probe.js                         dump every site, full JSON
//   node probe.js set <siteId> <level>    change security_level (disarmed/armed/partial)
//   node probe.js panic <siteId> [mode]   POST /panic (mode: alarm|silent, default alarm)
//
// Credentials: SOMFY_EMAIL / SOMFY_PASSWORD in the repo-root .env — use the
// SECONDARY account (owner role) created for this integration, never your own
// login. Token is cached in probe/somfy/.token.json (gitignored) so repeated
// runs don't re-authenticate with the password grant every time.

const fs = require('fs');
const path = require('path');
const { SomfyClient } = require('./somfy-client');
const { loadEnv, requireVars } = require('../env');

const TOKEN_FILE = path.join(__dirname, '.token.json');

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (err) {
    return null;
  }
}

function client() {
  const [username, password] = requireVars(['SOMFY_EMAIL', 'SOMFY_PASSWORD']);
  return new SomfyClient({
    username,
    password,
    tokens: loadTokens(),
    onTokens: (tokens) => fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2)),
  });
}

async function dump() {
  const api = client();
  const sites = await api.getSites();
  console.log(`${sites.length} site(s)\n`);
  console.log(JSON.stringify(sites, null, 2));
}

async function main() {
  loadEnv(); // surfaces a clear error early if .env is missing entirely
  const [mode, ...args] = process.argv.slice(2);

  if (!mode) return dump();

  const api = client();

  if (mode === 'set') {
    const [siteId, level] = args;
    if (!siteId || !level) throw new Error('usage: node probe.js set <siteId> <level>');
    const result = await api.setSecurityLevel(siteId, level);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === 'panic') {
    const [siteId, panicMode] = args;
    if (!siteId) throw new Error('usage: node probe.js panic <siteId> [alarm|silent]');
    const result = await api.triggerPanic(siteId, panicMode || 'alarm');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`unknown mode "${mode}"`);
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
