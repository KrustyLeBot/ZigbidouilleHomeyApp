'use strict';

// Read-only probe for the Xiaomi Robot Vacuum 5 (xiaomi.vacuum.ov31gl).
//
// The X20+ probe existed to settle where the status lived. Here the open
// question is different and bigger: the published spec puts status on 2/2 with
// an enum unrelated to the X20+'s Dreame one, and lists NO equivalent of 4/7 —
// the pending-task field that the X20+ driver depends on to tell "docked
// mid-clean to rinse the mop" from "job finished". Finding that field, or
// proving it does not exist, is the whole job here.
//
// Usage:
//   node probe.js              watch the state live (default)
//   node probe.js scan         read the candidate properties once
//   node probe.js <ip> <token> [mode]
//
// Nothing here ever commands the robot.

const MiioClient = require('./miio-client');
const { requireCredentials } = require('../env');

const MODES = ['watch', 'scan'];
const args = process.argv.slice(2);

// Accept either: probe.js [mode]  or  probe.js <ip> <token> [mode]
let mode = 'watch';
let credArgs = [];
if (args.length <= 1 && (args.length === 0 || MODES.includes(args[0]))) {
  mode = args[0] || 'watch';
} else {
  credArgs = [args[0], args[1]];
  mode = args[2] || 'watch';
}

const { address, token } = requireCredentials('VACUUM5', credArgs);

// Both mappings side by side: the X20+ layout and the published ov31gl one.
// Reading them together is what shows, in one shot, which family this firmware
// belongs to — rather than assuming it matches the spec.
const CANDIDATES = [
  // ov31gl spec
  { did: 'status_s2p2', siid: 2, piid: 2 },
  { did: 'fault_s2p3', siid: 2, piid: 3 },
  { did: 'area_s2p6', siid: 2, piid: 6 }, // 0.01 m2 per the spec
  { did: 'time_s2p7', siid: 2, piid: 7 }, // seconds per the spec
  { did: 'sweepmop_s2p96', siid: 2, piid: 96 },
  { did: 'station_s2p18', siid: 2, piid: 18 },
  { did: 'dryleft_s2p90', siid: 2, piid: 90 },
  // X20+ layout, to see whether any of it survives on this model
  { did: 'x20_status_s2p1', siid: 2, piid: 1 },
  { did: 'x20_area_s4p3', siid: 4, piid: 3 },
  { did: 'x20_time_s4p2', siid: 4, piid: 2 },
  { did: 'x20_task_s4p7', siid: 4, piid: 7 },
  // common to both
  { did: 'battery', siid: 3, piid: 1 },
  { did: 'charging', siid: 3, piid: 2 },
];

const BATCH = 12; // the robot drops oversized get_properties requests

async function getProps(client, props) {
  const out = {};
  for (let i = 0; i < props.length; i += BATCH) {
    const slice = props.slice(i, i + BATCH);
    const result = await client.call(
      'get_properties',
      slice.map((p) => ({ did: p.did, siid: p.siid, piid: p.piid })),
    );
    for (const entry of result) {
      // code 0 = readable. Any other code is the robot ANSWERING that the
      // property is not there — real evidence, unlike a timeout, which drops
      // the whole batch and proves nothing.
      out[entry.did] = entry.code === 0 ? entry.value : `<err ${entry.code}>`;
    }
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
      `  ${ok ? 'OK  ' : 'FAIL'} siid ${String(c.siid).padStart(2)} piid ${String(c.piid).padStart(3)}  ${c.did.padEnd(16)} = ${v}`,
    );
  }
  console.log('\nFAIL = the robot answered "no such property". Absent output = no answer at all.');
}

async function watch(client) {
  console.log('Watching. Ctrl+C to stop.');
  console.log('Drive it through every state — clean, pause, resume, dock, mop wash, dry —');
  console.log('and note which field moves. A field that CLIMBS during one activity is a');
  console.log('counter, not a state code (that mistake cost hours on the X20+).\n');

  let last = null;
  const tick = async () => {
    try {
      const v = await getProps(client, CANDIDATES);
      const line =
        `s2p2=${v.status_s2p2}  s2p1=${v.x20_status_s2p1}  ` +
        `area=${v.area_s2p6}  time=${v.time_s2p7}  ` +
        `sweepmop=${v.sweepmop_s2p96}  station=${v.station_s2p18}  ` +
        `s4p7=${v.x20_task_s4p7}  batt=${v.battery}  chg=${v.charging}  fault=${v.fault_s2p3}`;
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
    } else {
      await watch(client);
    }
  } catch (err) {
    console.error(`\nFailed: ${err.message}`);
    if (/timeout/i.test(err.message)) {
      console.error(
        'A handshake timeout means the robot is asleep, on another IP, or cloud-only.\n' +
          'Wake it in the Xiaomi app and retry.',
      );
    }
    client.destroy();
    process.exit(1);
  }
})();
