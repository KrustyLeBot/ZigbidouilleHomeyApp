'use strict';

// What this answers: WHICH enableType is the switch a given toggle in the Imou
// Life app actually drives.
//
// Asking one plausible-looking candidate at a time did not settle it: on the
// Cell PT both `alarmPIR` and `motionDetect` answer, and neither appeared to
// move across a real on/off cycle. A name that sounds right is not evidence —
// the only reliable method is the one that worked on the vacuums: dump every
// switch in one state, dump it again in the other, and DIFF.
//
//   node sweep.js save on.txt        # detection ON in the app
//   # ...toggle it off in the Imou Life app...
//   node sweep.js save off.txt
//   node sweep.js diff on.txt off.txt
//
//   node sweep.js                    # dump to stdout, no file
//
// Device defaults to IMOU_TEST_DEVICE from .env; pass `--device <serial>` to
// override. Output files are gitignored (probe/**/*.txt).
//
// Two things this deliberately gets right, both learned the hard way here:
//
//  - A REFUSAL and a TIMEOUT are recorded differently. An unsupported switch
//    answers with an error code; a flaky connection answers with nothing. An
//    early version of this sweep collapsed both to "not supported" and wiped
//    out a whole run's results as "(none)" during a transient ECONNREFUSED.
//  - Every call is retried, serialised, and spaced. The endpoint drops
//    requests that arrive in a burst.

const fs = require('fs');
const { ImouClient } = require('./imou-client');
const { loadEnv, requireVars } = require('../env');

// Every device capability switch the platform documents, so a switch with an
// unexpected name cannot hide. Sweeping all of them costs ~45 calls per run
// against a 30,000/MONTH account-wide budget — fine for occasional use, not
// something to loop.
const ENABLE_TYPES = [
  'localRecord', 'motionDetect', 'faceCapture', 'speechRecognition', 'breathingLight',
  'smartLocate', 'smartTrack', 'localAlarmRecord', 'regularCruise', 'headerDetect',
  'numberStat', 'manNumDec', 'alarmPIR', 'autoZoomFocus', 'audioEncodeControl',
  'aecv3', 'faceDetect', 'localStorageEnable', 'whiteLight', 'linkageWhiteLight',
  'linkageSiren', 'infraredLight', 'searchLight', 'hoveringAlarm', 'beOpenedDoor',
  'closeCamera', 'mobileDetect', 'rtFaceDetect', 'rtFaceCompa', 'closeDormant',
  'heatMap', 'tlsEnable', 'aiHumanCar', 'aiHuman', 'aiCar', 'openDoorByFace',
  'openDoorByTouch', 'linkDevAlarm', 'linkAccDevAlarm', 'abAlarmSound', 'playSound',
  'wideDynamic', 'smdHuman', 'smdVehicle', 'instantDisAlarm', 'periodDisAlarm',
  'ccss', 'inll', 'ledsw',
];

const RETRIES = 4;
const RETRY_DELAY = 600;
const GAP = 120; // between switches, so the endpoint does not drop the burst

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Codes meaning "the camera is not reachable right now", as opposed to "this
// camera does not have that switch". Kept apart deliberately: a sweep of a
// sleeping/offline camera otherwise reports all 49 switches as refused, which
// reads exactly like a model that supports nothing. Cost a wasted diagnosis
// once already on the Ranger 2C, which drops off Wi-Fi between uses.
const OFFLINE_CODES = new Set(['DV1007', 'DV1004', 'SN000']);

// Distinguishes the four outcomes that matter. `refused` is real evidence (the
// platform answered "this device does not have that switch"); `offline` and
// `unreachable` are no evidence at all about the switch itself and must never
// be read as "unsupported".
async function readSwitch(api, deviceId, enableType) {
  let lastErr;

  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const value = await api.getSwitch(deviceId, enableType);
      return { state: 'ok', value };
    } catch (err) {
      lastErr = err;
      // An ImouError carries a platform code: the device answered. No point
      // retrying a genuine refusal — only transport failures are worth another go.
      if (err.name === 'ImouError') {
        const state = OFFLINE_CODES.has(err.code) ? 'offline' : 'refused';
        return { state, why: err.message };
      }
      await sleep(RETRY_DELAY);
    }
  }

  return { state: 'unreachable', why: (lastErr && lastErr.message) || 'no reply' };
}

async function sweep(api, deviceId) {
  const rows = [];
  for (const enableType of ENABLE_TYPES) {
    const result = await readSwitch(api, deviceId, enableType);
    rows.push({ enableType, ...result });
    await sleep(GAP);
  }
  return rows;
}

function format(rows, deviceId) {
  const lines = [`# device ${deviceId}`, `# ${new Date().toISOString()}`, ''];
  for (const row of rows) {
    if (row.state === 'ok') lines.push(`${row.enableType}\t${row.value ? 'ON' : 'off'}`);
    else lines.push(`${row.enableType}\t-\t${row.state}`);
  }
  return lines.join('\n') + '\n';
}

function parse(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [enableType, value, state] = line.split('\t');
    if (enableType) out.set(enableType, state ? `(${state})` : value);
  }
  return out;
}

function diff(fileA, fileB) {
  const a = parse(fs.readFileSync(fileA, 'utf8'));
  const b = parse(fs.readFileSync(fileB, 'utf8'));

  const changed = [];
  for (const [key, valueA] of a) {
    const valueB = b.get(key);
    if (valueB !== undefined && valueA !== valueB) changed.push([key, valueA, valueB]);
  }

  if (!changed.length) {
    console.log(`No switch differs between ${fileA} and ${fileB}.`);
    console.log('Either the toggle is not exposed as an enableType at all, or the');
    console.log('cloud had not caught up — re-dump the second state and diff again.');
    return;
  }

  console.log(`${changed.length} switch(es) changed:\n`);
  for (const [key, valueA, valueB] of changed) {
    console.log(`  ${key.padEnd(22)} ${fileA}=${valueA}  ->  ${fileB}=${valueB}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);

  // `diff` needs no credentials and no network.
  if (argv[0] === 'diff') {
    const [, fileA, fileB] = argv;
    if (!fileA || !fileB) throw new Error('usage: node sweep.js diff <a.txt> <b.txt>');
    return diff(fileA, fileB);
  }

  const env = loadEnv();
  const [appId, appSecret] = requireVars(['IMOU_APP_ID', 'IMOU_APP_SECRET']);

  const deviceFlag = argv.indexOf('--device');
  const deviceId = deviceFlag !== -1 ? argv[deviceFlag + 1] : env.IMOU_TEST_DEVICE;
  if (!deviceId) {
    throw new Error('set IMOU_TEST_DEVICE in .env, or pass --device <serial>');
  }

  let host = env.IMOU_HOST;
  if (!host) {
    host = await ImouClient.discoverHost(appId, appSecret);
    console.error(`data centre: ${host} (set IMOU_HOST=${host} in .env to skip this)`);
  }

  const api = new ImouClient({ appId, appSecret, host });
  console.error(`sweeping ${ENABLE_TYPES.length} switches on ${deviceId}...`);
  const rows = await sweep(api, deviceId);

  const unreachable = rows.filter((r) => r.state === 'unreachable').length;
  if (unreachable) {
    // Loud, because a run riddled with these is not comparable to a clean one:
    // diffing it would report phantom changes where the network simply failed.
    console.error(`WARNING: ${unreachable} switch(es) did not answer — this run is unreliable, re-run it.`);
  }

  const offline = rows.filter((r) => r.state === 'offline').length;
  if (offline > rows.length / 2) {
    // The whole run says nothing about the model. Worth stating outright, or
    // the output reads as "this camera supports no switches at all".
    console.error(`WARNING: the camera reported itself offline for ${offline}/${rows.length} switches.`);
    console.error('This run proves NOTHING about which switches the model has — wake it and re-run.');
  }

  const text = format(rows, deviceId);

  if (argv[0] === 'save') {
    const file = argv[1];
    if (!file) throw new Error('usage: node sweep.js save <file.txt>');
    // Written here rather than shell-redirected: PowerShell's `>` writes
    // UTF-16LE with a BOM, which broke the vacuum sweeps' own diff.
    fs.writeFileSync(file, text, 'utf8');
    console.error(`wrote ${file}`);
    return;
  }

  process.stdout.write(text);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
