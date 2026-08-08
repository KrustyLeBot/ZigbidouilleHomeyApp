'use strict';

// Continuous timestamped watch for the Vacuum 5.
//
// sweep.js reads all 164 properties and takes ~5 s, which is too slow and far
// too noisy to line up with "I just paused it". This polls a narrow candidate
// set instead, every 5 s, and writes one timestamped CSV row per sample.
//
// Two outputs on purpose:
//   - the CSV (every sample) is the record to diff afterwards
//   - stdout prints ONLY when something changes, so the console stays readable
//     while driving the robot around
//
// Usage:
//   node watch.js [seconds] [file.csv]      defaults: 5 s, watch.csv
//
// Read-only: it never commands the robot.

const fs = require('fs');
const MiioClient = require('./miio-client');
const { requireCredentials } = require('../env');

// Established so far by sweeping through idle -> station prep -> cleaning ->
// pause. Anything still ambiguous is kept in the list rather than guessed at.
const FIELDS = [
  { key: 'status', siid: 2, piid: 2 }, // 14 docked, 7 station prep, 4 working, 1 cleaning, 5 paused
  { key: 'task', siid: 2, piid: 3 }, // 100008 idle, 100028 job pending — the 4/7 equivalent
  { key: 'area', siid: 2, piid: 6 }, // 0.01 m2, resets at job start
  { key: 'time', siid: 2, piid: 7 }, // seconds, resets at job start
  { key: 'station', siid: 2, piid: 18 }, // {"mode":n} — 3 while preparing the mop
  { key: 'battery', siid: 3, piid: 1 },
  { key: 'charging', siid: 3, piid: 2 },
  { key: 'mop', siid: 2, piid: 11 },
  { key: 'sweepmop', siid: 2, piid: 96 },
  { key: 'dryleft', siid: 2, piid: 90 },
  { key: 'fault', siid: 2, piid: 66 }, // {"ts":..,"fault":[0]} — the real fault
  // Unidentified but constant so far; they are the remaining candidates for
  // anything the fields above cannot explain.
  { key: 's2p4', siid: 2, piid: 4 },
  { key: 's2p5', siid: 2, piid: 5 },
  { key: 's2p8', siid: 2, piid: 8 },
  { key: 's2p9', siid: 2, piid: 9 },
  { key: 's2p40', siid: 2, piid: 40 },
  { key: 's2p74', siid: 2, piid: 74 },
  { key: 's2p83', siid: 2, piid: 83 },
];

const BATCH = 12; // the robot drops oversized get_properties requests

const args = process.argv.slice(2);
const seconds = Number(args[0]) > 0 ? Number(args[0]) : 5;
const outFile = args[1] || 'watch.csv';
const { address, token } = requireCredentials('VACUUM5', []);

// Keyed off the response's own siid/piid: this firmware overwrites the `did` we
// send with its numeric device id, so the label we asked for never comes back.
const BY_ADDRESS = new Map(FIELDS.map((f) => [`${f.siid}/${f.piid}`, f.key]));

async function read(client) {
  const out = {};
  for (let i = 0; i < FIELDS.length; i += BATCH) {
    const slice = FIELDS.slice(i, i + BATCH);
    const result = await client.call(
      'get_properties',
      slice.map((f) => ({ did: f.key, siid: f.siid, piid: f.piid })),
    );
    result.forEach((entry, index) => {
      const key = BY_ADDRESS.get(`${entry.siid}/${entry.piid}`) || slice[index]?.key;
      if (key && entry.code === 0) out[key] = entry.value;
    });
  }
  return out;
}

function stamp() {
  return new Date().toLocaleTimeString('fr-FR', { hour12: false });
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  const client = new MiioClient(address, token);
  try {
    await client.handshake();
  } catch (err) {
    console.error(`Handshake failed: ${err.message}`);
    process.exit(1);
  }

  const cols = FIELDS.map((f) => f.key);
  // Append rather than truncate, so an interrupted session does not lose the
  // run that led up to it.
  if (!fs.existsSync(outFile)) fs.writeFileSync(outFile, `time,${cols.join(',')}\n`, 'utf8');

  console.log(`Watching every ${seconds}s -> ${outFile}. Ctrl+C to stop.`);
  console.log('Only changes are printed. Say what you do and when; the timestamps line up.\n');

  let last = null;
  const tick = async () => {
    let values;
    try {
      values = await read(client);
    } catch (err) {
      // A timeout is the robot not answering — never evidence about a property.
      console.log(`[${stamp()}] read failed: ${err.message}`);
      return;
    }

    fs.appendFileSync(outFile, `${stamp()},${cols.map((c) => csvCell(values[c])).join(',')}\n`);

    // Print the fields most likely to be driving a state change, plus whatever
    // actually differs from the previous sample.
    const signature = cols.map((c) => `${c}=${values[c]}`).join(' ');
    if (signature !== last) {
      const changes = last === null
        ? 'first sample'
        : cols
          .filter((c) => `${c}=${values[c]}` !== last.split(' ').find((p) => p.startsWith(`${c}=`)))
          .map((c) => `${c}=${values[c]}`)
          .join('  ');
      console.log(
        `[${stamp()}] status=${values.status} task=${values.task} ` +
          `area=${values.area} time=${values.time} batt=${values.battery} chg=${values.charging}` +
          (changes ? `\n           changed: ${changes}` : ''),
      );
      last = signature;
    }
  };

  await tick();
  setInterval(tick, seconds * 1000);
})();
