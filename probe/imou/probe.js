'use strict';

// What this answers: which switches each Imou camera actually implements, and
// what they are called.
//
// The published capability table lists ~45 enableType values for the platform
// as a whole; any given camera implements a handful. The Ranger 2C, for one,
// offers privacy and notifications in the phone app but no detection toggle at
// all. Guessing which name carries which function is how a driver ends up
// declaring a capability that can never hold a value, so this asks the cameras.
//
// It also settles the open question the API docs do not: there is no documented
// per-camera push-notification switch (setMessageCallback is account-wide and
// capped at 10 changes a day), yet the phone app clearly has one. Whichever
// candidate below answers on the 2C is the one the driver should use.
//
// No pairing, no Homey, no app install — this talks straight to the cloud.
//
//   node probe.js                      full report on every camera
//   node probe.js raw <method> [json]  one arbitrary endpoint call
//   node probe.js get <deviceId> <enableType>
//   node probe.js set <deviceId> <enableType> <on|off>
//
// Credentials come from the repo-root .env (IMOU_APP_ID / IMOU_APP_SECRET), and
// IMOU_HOST pins the data centre once discovery has named it.

const { ImouClient } = require('./imou-client');
const { loadEnv, requireVars } = require('../env');

// Every switch worth asking about for these models, grouped by what it is for.
// Asked one by one because getDeviceCameraStatus takes a single enableType:
// ~25 calls per camera, against a budget of 30,000 a MONTH for the whole
// account — cheap enough for occasional probing, not for routine polling.
const CANDIDATES = {
  privacy: ['closeCamera', 'ccss'],
  detection: ['motionDetect', 'alarmPIR', 'mobileDetect', 'smdHuman', 'aiHuman', 'headerDetect'],
  // No documented per-device push switch, so every plausible name is tried.
  notification: ['instantDisAlarm', 'periodDisAlarm', 'linkDevAlarm', 'linkAccDevAlarm', 'abAlarmSound'],
  light: ['whiteLight', 'linkageWhiteLight', 'searchLight', 'infraredLight', 'ledsw', 'inll', 'breathingLight'],
  other: ['linkageSiren', 'smartTrack', 'localRecord', 'playSound', 'closeDormant'],
};

function client(env) {
  const [appId, appSecret] = requireVars(['IMOU_APP_ID', 'IMOU_APP_SECRET']);
  return new ImouClient({ appId, appSecret, host: env.IMOU_HOST || undefined });
}

async function resolveHost(env) {
  if (env.IMOU_HOST) return env.IMOU_HOST;

  const [appId, appSecret] = requireVars(['IMOU_APP_ID', 'IMOU_APP_SECRET']);
  process.stdout.write('Looking for the data centre holding the account... ');
  const host = await ImouClient.discoverHost(appId, appSecret);
  console.log(`${host}\n  (put IMOU_HOST=${host} in .env to skip this next time)\n`);
  return host;
}

// Reads one switch. A model that does not implement it answers with an error
// rather than a value, and that refusal is the useful result — it is evidence,
// unlike a timeout. Both are reported, kept apart.
async function probeSwitch(api, deviceId, enableType) {
  try {
    const value = await api.getSwitch(deviceId, enableType);
    return { supported: true, value };
  } catch (err) {
    return { supported: false, why: err.message };
  }
}

async function report(env) {
  const host = await resolveHost(env);
  const api = client({ ...env, IMOU_HOST: host });

  const devices = await api.devices();
  if (!devices.length) {
    console.log('No devices. Check that the cameras are in the Imou Life app on');
    console.log('the same account, and that the data centre above is the right one.');
    return;
  }

  console.log(`${devices.length} device(s)\n`);

  for (const device of devices) {
    const id = device.deviceId;
    console.log('='.repeat(72));
    console.log(`${device.name || '(unnamed)'}   ${id}`);
    console.log(`  model=${device.deviceModel || '?'}  catalog=${device.catalog || '?'}  ` +
      `status=${device.status || '?'}  access=${device.accessType || '?'}`);
    console.log(`  channels=${device.channelNum ?? '?'}  version=${device.version || '?'}`);

    // Raw, unabridged: the ability names are the ground truth and are worth
    // reading in full even where they do not match an enableType one for one.
    try {
      const abilities = await api.abilities(id);
      console.log(`\n  listDeviceAbility:\n${JSON.stringify(abilities, null, 2).replace(/^/gm, '    ')}`);
    } catch (err) {
      console.log(`\n  listDeviceAbility failed: ${err.message}`);
    }

    console.log('\n  switches:');
    for (const [group, types] of Object.entries(CANDIDATES)) {
      const lines = [];
      for (const enableType of types) {
        const result = await probeSwitch(api, id, enableType);
        if (result.supported) lines.push(`      ${enableType.padEnd(20)} ${result.value ? 'ON' : 'off'}`);
      }
      // Only supported switches are printed: a list of 20 refusals per camera
      // buries the four lines that matter. Re-run with `get` for a specific one.
      console.log(`    ${group}:`);
      console.log(lines.length ? lines.join('\n') : '      (none)');
    }

    try {
      const power = await api.powerInfo(id);
      console.log(`\n  battery: ${JSON.stringify(power)}`);
    } catch (err) {
      console.log(`\n  battery: not reported (${err.message})`);
    }

    console.log('');
  }
}

async function main() {
  const env = loadEnv();
  const [mode, ...args] = process.argv.slice(2);

  if (!mode) return report(env);

  const host = await resolveHost(env);
  const api = client({ ...env, IMOU_HOST: host });

  if (mode === 'raw') {
    const [method, json] = args;
    if (!method) throw new Error('usage: node probe.js raw <method> [jsonParams]');
    const data = await api.request(method, json ? JSON.parse(json) : {});
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (mode === 'get') {
    const [deviceId, enableType] = args;
    if (!deviceId || !enableType) throw new Error('usage: node probe.js get <deviceId> <enableType>');
    console.log(await api.getSwitch(deviceId, enableType) ? 'ON' : 'off');
    return;
  }

  if (mode === 'set') {
    const [deviceId, enableType, value] = args;
    if (!deviceId || !enableType || !value) {
      throw new Error('usage: node probe.js set <deviceId> <enableType> <on|off>');
    }
    await api.setSwitch(deviceId, enableType, value === 'on');
    console.log(`${enableType} -> ${value}`);
    return;
  }

  throw new Error(`unknown mode "${mode}"`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
