'use strict';

// Shared .env reader for every probe script. The file lives at the repo root
// and is gitignored: it holds each robot's IP and its 32-char miIO token, which
// is a password. Never print a token, never copy one into a doc or a log.
//
// The pattern allows DIGITS in the key. The original per-script copy used
// [A-Z_]+, which silently skipped VACUUM5_IP — an unset variable and a
// mis-parsed one look identical at the call site, so it is worth being exact.

const fs = require('fs');
const path = require('path');

function loadEnv() {
  // probe/<device>/script.js -> probe/ -> repo root. Callers live one level
  // deeper than this file, so resolve from here, not from the caller.
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return {};

  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// Resolves credentials for one device, preferring explicit CLI arguments.
// `prefix` is the .env namespace, e.g. 'VACUUM5' -> VACUUM5_IP / VACUUM5_TOKEN.
function credentials(prefix, argv = []) {
  const env = loadEnv();
  const address = argv[0] || env[`${prefix}_IP`];
  const token = argv[1] || env[`${prefix}_TOKEN`];
  return { address, token };
}

// Fails loudly rather than letting a bad token turn into an unexplained
// handshake timeout ten seconds later.
function requireCredentials(prefix, argv = []) {
  const { address, token } = credentials(prefix, argv);

  if (!address || !token) {
    console.error(`Set ${prefix}_IP and ${prefix}_TOKEN in the repo-root .env,`);
    console.error('or pass <ip> <token> on the command line.');
    process.exit(1);
  }
  if (!/^[0-9a-fA-F]{32}$/.test(token)) {
    console.error(`${prefix}_TOKEN must be 32 hex characters.`);
    process.exit(1);
  }

  return { address, token };
}

// Same idea for devices whose credentials are not an IP/token pair — the Imou
// cameras are an appId/appSecret against a cloud endpoint. Returns the values in
// the order asked for, and names the ones that are missing rather than failing
// later inside an HTTP call, where a blank secret comes back as a signature
// error and reads like a bug in the signing code.
function requireVars(names) {
  const env = loadEnv();
  const missing = names.filter((name) => !env[name]);

  if (missing.length) {
    console.error(`Set ${missing.join(', ')} in the repo-root .env.`);
    process.exit(1);
  }

  return names.map((name) => env[name]);
}

module.exports = { loadEnv, credentials, requireCredentials, requireVars };
