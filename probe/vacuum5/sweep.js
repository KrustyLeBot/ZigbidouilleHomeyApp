'use strict';

// Brute-force property sweep for the Xiaomi Robot Vacuum 5 (xiaomi.vacuum.ov31gl).
//
// Same tool as probe/x20plus/sweep.js, with a wider range: the published spec
// for this model lists ~84 properties on the vacuum service alone (up to piid
// 101), where the X20+ needed no more than 30.
//
// The point is not the single dump, it is the DIFF between two states:
//   node sweep.js > idle.txt
//   (start a clean, or pause it, or lift the robot)
//   node sweep.js > cleaning.txt
//   node sweep.js diff idle.txt cleaning.txt
//
// That diff is what identifies a field. A published spec has already been wrong
// for the X20+ — see CLAUDE.md — so nothing here is trusted until it moves the
// way the Xiaomi app says it should.

const fs = require('fs');
const MiioClient = require('./miio-client');
const { requireCredentials } = require('../env');

const MAX_SIID = 20;
const MAX_PIID = 101; // the ov31gl spec runs to 2/101 (host-water-tank-status)
const BATCH = 12; // the robot drops oversized get_properties requests

// Names from the published spec, used only to annotate the dump. A label here
// is a HINT, never evidence: the value's behaviour decides what a field means.
const HINTS = {
  s2p2: 'status?',
  s2p3: 'fault?',
  s2p6: 'cleaning-area? (0.01 m2)',
  s2p7: 'cleaning-time? (s)',
  s2p10: 'mop-water-output-level?',
  s2p11: 'mop-status?',
  s2p18: 'base-station-working-status?',
  s2p29: 'frequency-mop-wash?',
  s2p31: 'drying-time?',
  s2p88: 'drying-progress?',
  s2p90: 'dry-left-time?',
  s2p96: 'sweep-mop-status?',
  s2p97: 'sewage-tank-status?',
  s2p98: 'water-tank-status?',
  s2p100: 'base-station-water-tank-status?',
  s2p101: 'host-water-tank-status?',
  s3p1: 'battery-level?',
  s3p2: 'charging-state?',
  s3p3: 'voltage?',
};

// The key is rebuilt from the RESPONSE's own siid/piid, never from `did`.
//
// This firmware overwrites the `did` we send with the robot's numeric device
// id, so every entry comes back labelled identically and the whole dump becomes
// unidentifiable. (The X20+ echoes our `did` back, which is why the original
// sweep could rely on it.) Falling back to request order is a last resort: it
// only holds if the robot answers every property in the order asked.
function keyOf(entry, request, index) {
  if (typeof entry.siid === 'number' && typeof entry.piid === 'number') {
    return `s${entry.siid}p${entry.piid}`;
  }
  const asked = request[index];
  return asked ? `s${asked.siid}p${asked.piid}` : null;
}

async function readBatch(client, props) {
  try {
    const result = await client.call('get_properties', props);
    const out = [];
    result.forEach((entry, index) => {
      if (entry.code !== 0 || entry.value === undefined) return;
      const key = keyOf(entry, props, index);
      if (key) out.push({ key, value: entry.value });
    });
    return out;
  } catch (err) {
    // A dropped batch is NOT evidence that the properties are missing — the
    // robot simply did not answer. Reported so a silent hole in the dump is
    // never mistaken for a refusal.
    console.error(`  (no answer for s${props[0].siid}p${props[0].piid}..p${props[props.length - 1].piid})`);
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

// Reads a dump whatever the shell encoded it as. PowerShell's `>` writes
// UTF-16LE with a BOM, which parses as one character out of two and silently
// yields an empty diff — so detect it rather than trusting the extension.
function readDump(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le').slice(1);
  return buf.toString('utf8').replace(/^﻿/, '');
}

function parseFile(file) {
  const map = new Map();
  for (const line of readDump(file).split('\n')) {
    const m = line.match(/^(s\d+p\d+)\s*=\s*(.*)$/);
    // Strip the trailing "# hint" comment so a hint change never reads as a
    // value change.
    if (m) map.set(m[1], m[2].replace(/\s+#.*$/, '').trim());
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
      const hint = HINTS[k] ? `  (${HINTS[k]})` : '';
      console.log(`  ${k.padEnd(10)} ${String(va).padStart(10)}  ->  ${String(vb).padEnd(10)}${hint}`);
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

  // `save <file>` writes the dump itself, in UTF-8.
  let outFile = null;
  let credArgs = args;
  if (args[0] === 'save') {
    outFile = args[1];
    if (!outFile) {
      console.error('Usage: node sweep.js save <file.txt>');
      process.exit(1);
    }
    credArgs = args.slice(2);
  }

  const { address, token } = requireCredentials('VACUUM5', credArgs);
  const client = new MiioClient(address, token);

  try {
    await client.handshake();
  } catch (err) {
    console.error(`Handshake failed: ${err.message}`);
    console.error('The robot may be asleep, on another IP, or the token may be stale.');
    client.destroy();
    process.exit(1);
  }

  const found = await sweep(client);
  const lines = found.map((f) => {
    const hint = HINTS[f.key] ? `  # ${HINTS[f.key]}` : '';
    return `${f.key} = ${f.value}${hint}`;
  });

  if (outFile) {
    // Written here rather than piped, because PowerShell's `>` produces UTF-16.
    fs.writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
    console.error(`${found.length} readable properties -> ${outFile}`);
  } else {
    for (const line of lines) console.log(line);
    // stderr so it never lands in a redirected dump that diff will parse.
    console.error(`\n${found.length} readable properties.`);
  }
  client.destroy();
})();
