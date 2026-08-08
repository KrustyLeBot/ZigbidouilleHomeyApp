'use strict';

// Read-only probe for the Xiaomi X20+ (xiaomi.vacuum.c102gl).
// Resolves two unknowns that specs disagree on:
//   1. which siid/piid actually carries the status, and what values it reports
//   2. whether a "continue/resume" action exists on this firmware
//
// Usage:
//   node probe.js <ip> <token>              watch status live (default)
//   node probe.js <ip> <token> scan         dump candidate properties once
//   node probe.js <ip> <token> actions      list resume-action candidates (does NOT run them)

const MiioClient = require('./miio-client');
const { loadEnv } = require('../env');

const env = loadEnv();
const args = process.argv.slice(2);

// Accept either: probe.js [mode]  or  probe.js <ip> <token> [mode]
const MODES = ['watch', 'scan', 'actions'];
let address;
let token;
let mode;

if (args.length <= 1 && (args.length === 0 || MODES.includes(args[0]))) {
  address = env.ROBOT_IP;
  token = env.ROBOT_TOKEN;
  mode = args[0] || 'watch';
} else {
  [address, token, mode = 'watch'] = args;
}

if (!address || !token) {
  console.error('Usage: node probe.js [watch|scan|actions]   (reads ../.env)');
  console.error('   or: node probe.js <ip> <token-32-hex> [watch|scan|actions]');
  process.exit(1);
}

if (!/^[0-9a-fA-F]{32}$/.test(token)) {
  console.error('Token must be 32 hex characters.');
  process.exit(1);
}

// Both candidate mappings, so we can see which one is real.
const CANDIDATES = [
  { did: 'status_s2p1', siid: 2, piid: 1 }, // working app says status
  { did: 'status_s2p2', siid: 2, piid: 2 }, // recap doc says status
  { did: 'fault_s2p2', siid: 2, piid: 2 },
  { did: 'fault_s2p3', siid: 2, piid: 3 },
  { did: 'battery', siid: 3, piid: 1 },
  { did: 'charging', siid: 3, piid: 2 },
  { did: 'mode_s2p4', siid: 2, piid: 4 },
  { did: 'clean_area', siid: 2, piid: 6 },
  { did: 'clean_time', siid: 2, piid: 7 },
];

// Resume-related actions worth confirming. Never invoked by this script.
const RESUME_CANDIDATES = [
  { name: 'Continue Sweep (doc aiid 8)', siid: 2, aiid: 8 },
  { name: 'Start Sweep (aiid 1)', siid: 2, aiid: 1 },
  { name: 'Stop Sweeping (aiid 2)', siid: 2, aiid: 2 },
  { name: 'Go Charge (siid 3 aiid 1)', siid: 3, aiid: 1 },
];

async function getProps(client, props) {
  const result = await client.call(
    'get_properties',
    props.map((p) => ({ did: p.did, siid: p.siid, piid: p.piid }))
  );
  const out = {};
  for (const entry of result) {
    // code 0 = readable; anything else means the property does not exist here.
    out[entry.did] = entry.code === 0 ? entry.value : `<err ${entry.code}>`;
  }
  return out;
}

async function scan(client) {
  console.log('Reading candidate properties...\n');
  const values = await getProps(client, CANDIDATES);
  for (const c of CANDIDATES) {
    const v = values[c.did];
    const ok = typeof v !== 'string' || !v.startsWith('<err');
    console.log(
      `  ${ok ? 'OK  ' : 'FAIL'} siid ${String(c.siid).padStart(2)} piid ${String(c.piid).padStart(2)}  ${c.did.padEnd(14)} = ${v}`
    );
  }
  console.log('\nProperties marked FAIL do not exist on this firmware.');
}

async function actions(client) {
  console.log('Checking which actions exist (read-only, nothing is executed).\n');
  // A no-arg action probe returns an error code if the aiid is unknown,
  // but running it would move the robot -- so we only report the candidates.
  for (const a of RESUME_CANDIDATES) {
    console.log(`  siid ${a.siid} aiid ${a.aiid}  ${a.name}`);
  }
  console.log(
    '\nTo confirm "resume", put the robot mid-clean, dock it manually, then run:\n' +
      '  node probe.js <ip> <token> watch\n' +
      'and trigger resume from the Xiaomi app while watching which status value appears.'
  );
}

async function watch(client) {
  console.log('Watching status. Ctrl+C to stop.');
  console.log('Drive the robot through states (clean, pause, dock, resume) and note the values.\n');

  let last = null;
  const tick = async () => {
    try {
      const v = await getProps(client, CANDIDATES);
      const line = `s2p1=${v.status_s2p1}  s2p2=${v.status_s2p2}  batt=${v.battery}  charging=${v.charging}  fault=${v.fault_s2p3}`;
      if (line !== last) {
        console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
        last = line;
      }
    } catch (err) {
      console.log(`[${new Date().toLocaleTimeString()}] read failed: ${err.message}`);
    }
  };

  await tick();
  setInterval(tick, 3000);
}

(async () => {
  const client = new MiioClient(address, token);
  try {
    await client.handshake();
    console.log(`Connected to ${address}\n`);

    if (mode === 'scan') {
      await scan(client);
      client.destroy();
    } else if (mode === 'actions') {
      await actions(client);
      client.destroy();
    } else {
      await watch(client);
    }
  } catch (err) {
    console.error(`\nFailed: ${err.message}`);
    if (/timeout/i.test(err.message)) {
      console.error(
        'Handshake timeout means the robot is asleep, on another IP, or cloud-only.\n' +
          'Wake it in the Xiaomi app and retry.'
      );
    }
    client.destroy();
    process.exit(1);
  }
})();
