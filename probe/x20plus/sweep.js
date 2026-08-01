'use strict';

// Brute-force property sweep: reads every siid/piid in a range and reports the
// ones that exist. Used to hunt for flags the app does not know about yet
// (e.g. a "wheels lifted" sensor that the Xiaomi app clearly reacts to).
//
// Run it twice - once with the robot normal, once in the odd state - and diff:
//   node sweep.js > normal.txt
//   (lift the robot)
//   node sweep.js > lifted.txt
//   node sweep.js diff normal.txt lifted.txt

const fs = require('fs');
const path = require('path');
const MiioClient = require('./miio-client');

function loadEnv() {
  // Two levels up: probe/x20plus/ -> probe/ -> repo root, where .env lives.
  const file = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const MAX_SIID = 20;
const MAX_PIID = 30;
const BATCH = 12; // the robot drops oversized get_properties requests

async function readBatch(client, props) {
  try {
    const result = await client.call('get_properties', props);
    const out = [];
    for (const entry of result) {
      if (entry.code === 0 && entry.value !== undefined) {
        out.push({ did: entry.did, value: entry.value });
      }
    }
    return out;
  } catch (err) {
    return [];
  }
}

async function sweep(client) {
  const found = [];
  for (let siid = 1; siid <= MAX_SIID; siid += 1) {
    let batch = [];
    for (let piid = 1; piid <= MAX_PIID; piid += 1) {
      batch.push({ did: `s${siid}p${piid}`, siid, piid });
      if (batch.length === BATCH) {
        found.push(...(await readBatch(client, batch)));
        batch = [];
      }
    }
    if (batch.length) found.push(...(await readBatch(client, batch)));
  }
  return found;
}

function parseFile(file) {
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(s\d+p\d+)\s*=\s*(.*)$/);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

function diff(fileA, fileB) {
  const a = parseFile(fileA);
  const b = parseFile(fileB);
  const keys = new Set([...a.keys(), ...b.keys()]);
  let changes = 0;
  for (const k of [...keys].sort()) {
    const va = a.get(k);
    const vb = b.get(k);
    if (va !== vb) {
      console.log(`  ${k.padEnd(10)} ${String(va).padStart(8)}  ->  ${vb}`);
      changes += 1;
    }
  }
  console.log(changes ? `\n${changes} field(s) differ.` : '\nNo field differs.');
}

(async () => {
  const args = process.argv.slice(2);

  if (args[0] === 'diff') {
    if (args.length < 3) {
      console.error('Usage: node sweep.js diff <before.txt> <after.txt>');
      process.exit(1);
    }
    diff(args[1], args[2]);
    return;
  }

  const env = loadEnv();
  const address = env.ROBOT_IP;
  const token = env.ROBOT_TOKEN;
  if (!address || !token) {
    console.error('Set ROBOT_IP and ROBOT_TOKEN in ../.env');
    process.exit(1);
  }

  const client = new MiioClient(address, token);
  const found = await sweep(client);
  for (const f of found) console.log(`${f.did} = ${f.value}`);
  console.error(`\n${found.length} readable properties.`);
  client.destroy();
})();
