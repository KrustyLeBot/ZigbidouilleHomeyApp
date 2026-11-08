'use strict';

// End to end: the real bridge process, a fake PLAF301 on MQTT, and the API as
// Homey uses it. The fake feeder speaks the messages documented by
// petlibro-local; what it checks is that the bridge plays the cloud's part.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mqtt = require('mqtt');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');

const SERIAL = 'AF0601TESTSERIAL01';
const MQTT_PORT = 18830 + Math.floor(Math.random() * 100);
const HTTP_PORT = 18480 + Math.floor(Math.random() * 100);
const AUTH = `Basic ${Buffer.from('homey:pw').toString('base64')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${p}`, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitFor(fn, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('bridge plays the cloud for a PLAF301', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plb-'));
  fs.writeFileSync(path.join(dir, 'htpasswd'), `homey:${bcrypt.hashSync('pw', 4)}\n`);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, MQTT_PORT, HTTP_PORT, DATA_DIR: dir, HTPASSWD_FILE: path.join(dir, 'htpasswd'), TZ: 'Europe/Paris' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  t.after(() => proc.kill('SIGTERM'));
  await waitFor(() => output.includes('API listening'), 'bridge start', 8000);

  // Unauthenticated API is refused, health is open.
  assert.strictEqual((await fetch(`http://127.0.0.1:${HTTP_PORT}/api/feeders`)).status, 401);
  assert.strictEqual((await fetch(`http://127.0.0.1:${HTTP_PORT}/health`)).status, 200);

  // Browser login: no Basic popup, a form, then a session cookie that opens the
  // page and the API; logout kills it.
  const base = `http://127.0.0.1:${HTTP_PORT}`;
  const anon = await fetch(`${base}/api/feeders`);
  assert.strictEqual(anon.headers.get('www-authenticate'), null);
  const page = await fetch(`${base}/`, { redirect: 'manual' });
  assert.strictEqual(page.status, 303);
  assert.strictEqual(page.headers.get('location'), '/login');
  const form = await (await fetch(`${base}/login`)).text();
  assert.match(form, /autocomplete="current-password"/);
  const bad = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username: 'homey', password: 'nope' }), redirect: 'manual' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.headers.get('set-cookie'), null);
  const good = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username: 'homey', password: 'pw' }), redirect: 'manual' });
  assert.strictEqual(good.status, 303);
  const cookie = good.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const session = cookie.split(';')[0];
  assert.strictEqual((await fetch(`${base}/`, { headers: { Cookie: session } })).status, 200);
  assert.strictEqual((await fetch(`${base}/api/feeders`, { headers: { Cookie: session } })).status, 200);
  await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: session }, redirect: 'manual' });
  assert.strictEqual((await fetch(`${base}/api/feeders`, { headers: { Cookie: session } })).status, 401);

  // A client that is neither a feeder serial nor a known login is refused.
  const intruder = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, { clientId: 'random-client', reconnectPeriod: 0 });
  const refused = await new Promise((resolve) => {
    intruder.on('error', () => resolve(true));
    intruder.on('connect', () => resolve(false));
  });
  intruder.end(true);
  assert.strictEqual(refused, true);

  // Homey's event stream.
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/api/events`, { headers: { Authorization: AUTH } });
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await waitFor(() => events.find((e) => e.type === 'hello'), 'hello');

  // The fake feeder, with whatever Petlibro login it carries.
  const received = [];
  const feeder = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, {
    clientId: SERIAL, username: 'petlibro-user', password: 'petlibro-pass', reconnectPeriod: 0,
  });
  await new Promise((resolve, reject) => { feeder.on('connect', resolve); feeder.on('error', reject); });
  await new Promise((resolve) => feeder.subscribe(`dl/PLAF301/${SERIAL}/device/+/sub`, resolve));
  // What a real PLAF301 (fw 3.0.72) also subscribes to on connect. Refusing it
  // used to drop the connection; it must be granted and the feeder kept.
  const granted = await new Promise((resolve) => feeder.subscribe('dl/PLAF301/device/broadcast/sub', (err, g) => resolve(g)));
  assert.strictEqual(granted[0].qos, 0);
  // Anything foreign is negated, never a reason to disconnect.
  // (mqtt.js reports the 0x80 SUBACK as an error.)
  const negated = await new Promise((resolve) => feeder.subscribe('dl/PLAF301/AF06OTHERSERIAL00/device/+/sub', (err) => resolve(err)));
  assert.ok(negated, 'foreign subscription must be refused');
  await sleep(200);
  assert.strictEqual(feeder.connected, true, 'a refused subscription must not drop the feeder');
  feeder.on('message', (topic, payload) => received.push({ topic, data: JSON.parse(payload.toString()) }));
  const post = (channel, data) => feeder.publish(`dl/PLAF301/${SERIAL}/device/${channel}/post`, JSON.stringify({ ts: Date.now(), ...data }));
  const got = (cmd, channel) => received.find((m) => m.data.cmd === cmd && (!channel || m.topic.endsWith(`/${channel}/sub`)));

  // A feeder may not publish under another serial.
  // (checked with a separate client at the end: aedes drops a client whose publish is refused)

  post('event', { cmd: 'DEVICE_START_EVENT', msgId: 'boot1', softwareVersion: '3.0.72', hardwareVersion: '5.0.0', success: true });
  const startAck = await waitFor(() => got('DEVICE_START_EVENT', 'event'), 'DEVICE_START ack');
  assert.strictEqual(startAck.data.msgId, 'boot1');
  assert.strictEqual(startAck.data.code, 0);
  await waitFor(() => got('ATTR_GET_SERVICE', 'service'), 'attribute poll');

  // Time request with a clock 2 s off: answered, told to keep its clock.
  post('ntp', { cmd: 'NTP', ts: Date.now() - 2000 });
  const ntp = await waitFor(() => got('NTP', 'ntp'), 'NTP answer');
  assert.strictEqual(ntp.data.code, 0);
  assert.strictEqual(ntp.data.calibrationTag, false);
  assert.ok([1, 2].includes(ntp.data.timezone));
  assert.ok(typeof ntp.data.nextDSTTransitionTs === 'number');

  // State push -> Homey sees battery, power, food.
  post('event', { cmd: 'ATTR_PUSH_EVENT', electricQuantity: 87, powerType: 3, surplusGrain: true, barnDoorState: false, coverOpenMode: 'CUSTOM' });
  await waitFor(() => events.find((e) => e.type === 'state' && e.feeder.battery === 87 && e.feeder.power === 'mains'), 'state push');

  // Initial reading already low -> alert at once; blocked outlet -> alert.
  post('event', { cmd: 'ATTR_PUSH_EVENT', surplusGrain: false, grainOutletState: false });
  await waitFor(() => events.find((e) => e.type === 'event' && e.event.type === 'outlet_blocked'), 'outlet_blocked');
  post('event', { cmd: 'ATTR_PUSH_EVENT', surplusGrain: true, grainOutletState: true });
  await waitFor(() => events.find((e) => e.type === 'event' && e.event.type === 'outlet_cleared'), 'outlet_cleared');
  await waitFor(() => events.find((e) => e.type === 'event' && e.event.type === 'food_refilled'), 'food_refilled');

  // Refill reminder: settable and resettable through the API.
  const rem = await api('PUT', `/api/feeders/${SERIAL}/refill-reminder`, { intervalDays: 7, time: '18:30' });
  assert.strictEqual(rem.status, 200, JSON.stringify(rem.body));
  assert.deepStrictEqual([rem.body.intervalDays, rem.body.time, rem.body.enabled], [7, '18:30', true]);
  assert.strictEqual((await api('PUT', `/api/feeders/${SERIAL}/refill-reminder`, { time: '25:00' })).status, 400);
  const marked = await api('POST', `/api/feeders/${SERIAL}/refill`);
  assert.strictEqual(marked.body.daysSinceRefill, 0);

  // Power cut -> event.
  post('event', { cmd: 'ATTR_PUSH_EVENT', powerType: 2 });
  await waitFor(() => events.find((e) => e.type === 'event' && e.event.type === 'on_battery'), 'on_battery event');

  // Before Homey set a schedule, a plan request gets an empty list.
  post('event', { cmd: 'GET_FEEDING_PLAN_EVENT', msgId: 'p0' });
  const emptyPlans = await waitFor(() => got('GET_FEEDING_PLAN_EVENT', 'event'), 'plan answer');
  assert.deepStrictEqual(emptyPlans.data.plans, []);

  // Homey sets the schedule.
  const sched = await api('PUT', `/api/feeders/${SERIAL}/schedule`, {
    timezone: 'Europe/Paris', callSound: false,
    meals: [{ time: '08:00', days: [1, 2, 3, 4, 5, 6, 7], portions: 2 }, { time: '19:30', days: [6, 7], portions: 1 }],
  });
  assert.strictEqual(sched.status, 200, JSON.stringify(sched.body));
  const planMsg = await waitFor(() => got('FEEDING_PLAN_SERVICE', 'service'), 'plans sent');
  assert.strictEqual(planMsg.data.plans.length, 2);
  assert.strictEqual(planMsg.data.plans[0].enableAudio, false);
  const offset = new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' }).includes('GMT+2') ? 2 : 1;
  assert.strictEqual(planMsg.data.plans.find((p) => p.grainNum === 2).executionTime, `${String(8 - offset).padStart(2, '0')}:00`);

  // The feeder acks with the planIds and syncTime it stored.
  post('service', { cmd: 'FEEDING_PLAN_SERVICE', code: 0, plans: planMsg.data.plans.map(({ planId, syncTime }) => ({ planId, syncTime })) });
  await waitFor(() => events.find((e) => e.type === 'state' && e.feeder.schedule && e.feeder.schedule.acked), 'plans acked');

  // Manual feed -> command, then dispense progress is acked and reported as manual.
  assert.strictEqual((await api('POST', `/api/feeders/${SERIAL}/feed`, { portions: 3 })).status, 200);
  const feed = await waitFor(() => got('MANUAL_FEEDING_SERVICE', 'service'), 'manual feed');
  assert.strictEqual(feed.data.grainNum, 3);
  // The feeder reports the dispense under the msgId of the command (observed).
  post('event', { cmd: 'GRAIN_OUTPUT_EVENT', msgId: feed.data.msgId, execStep: 'GRAIN_END', finished: true, actualGrainNum: 3 });
  const grainAck = await waitFor(() => got('GRAIN_OUTPUT_EVENT', 'event'), 'grain ack');
  assert.strictEqual(grainAck.data.execStep, 'GRAIN_END');
  assert.strictEqual(grainAck.data.msgId, feed.data.msgId);
  const fed = await waitFor(() => events.find((e) => e.type === 'event' && e.event.type === 'fed'), 'fed event');
  assert.deepStrictEqual([fed.event.portions, fed.event.source], [3, 'manual']);

  // A second feed while one dispenses is refused by the bridge itself.
  assert.strictEqual((await api('POST', `/api/feeders/${SERIAL}/feed`, { portions: 1 })).status, 200);
  const busy = await api('POST', `/api/feeders/${SERIAL}/feed`, { portions: 1 });
  assert.strictEqual(busy.status, 400);
  assert.match(busy.body.error, /already in progress/);
  await waitFor(() => received.filter((m) => m.data.cmd === 'MANUAL_FEEDING_SERVICE').length === 2, 'second feed command');
  const second = received.filter((m) => m.data.cmd === 'MANUAL_FEEDING_SERVICE').pop();
  // The feeder's own busy refusal (2002, as observed) is not an empty meal.
  post('event', { cmd: 'ERROR_EVENT', errorCode: 2002 });
  post('event', { cmd: 'GRAIN_OUTPUT_EVENT', msgId: 'other', execStep: 'GRAIN_END', finished: true, actualGrainNum: 0 });
  // The real dispense, matched to its command by msgId, is manual.
  post('event', { cmd: 'GRAIN_OUTPUT_EVENT', msgId: second.data.msgId, execStep: 'GRAIN_END', finished: true, actualGrainNum: 1 });
  await waitFor(() => events.filter((e) => e.type === 'event' && e.event.type === 'fed').length === 2, 'second fed');
  const fed2 = events.filter((e) => e.type === 'event' && e.event.type === 'fed')[1];
  assert.strictEqual(fed2.event.source, 'manual');
  assert.strictEqual(events.filter((e) => e.type === 'event' && ['feed_failed', 'device_error'].includes(e.event.type)).length, 0);

  // Lid, settings, display, pets, jam.
  assert.strictEqual((await api('POST', `/api/feeders/${SERIAL}/lid`, { open: true })).status, 200);
  assert.strictEqual((await waitFor(() => got('SWITCH_DOOR_SERVICE'), 'lid')).data.barnDoorState, true);
  assert.strictEqual((await api('POST', `/api/feeders/${SERIAL}/settings`, { lidMode: 'KEEP_OPEN', volume: 30 })).status, 200);
  await waitFor(() => received.find((m) => m.data.coverOpenMode === 'KEEP_OPEN'), 'lid mode');
  assert.strictEqual((await api('POST', `/api/feeders/${SERIAL}/settings`, { lidMode: 'WIDE' })).status, 400);
  const disp = await api('POST', `/api/feeders/${SERIAL}/display`, { text: 'Minou' });
  assert.strictEqual(disp.body.text, 'MINOU');
  await waitFor(() => got('DISPLAY_MATRIX_SERVICE'), 'display');
  post('event', { cmd: 'PET_IDENTIFY_EVENT', rfid: '900123', type: 'NEAR' });
  post('event', { cmd: 'PET_IDENTIFY_EVENT', rfid: '900123', type: 'LEAVE' });
  await waitFor(() => events.find((e) => e.type === 'event' && e.event.type === 'pet_left' && e.event.rfid === '900123'), 'pet_left');
  post('event', { cmd: 'ERROR_EVENT', errorCode: 2032 });
  await waitFor(() => events.find((e) => e.type === 'event' && e.event.type === 'lid_jammed'), 'lid_jammed');
  post('event', { cmd: 'WAREHOUSE_DOOR_EVENT', barnDoorState: false });
  await waitFor(() => events.find((e) => e.type === 'event' && e.event.type === 'lid_unjammed'), 'lid_unjammed');

  // Messages written by a cloud (linkId) are ignored, not acted on.
  const before = received.length;
  post('event', { cmd: 'DEVICE_START_EVENT', msgId: 'cloud', linkId: 'x' });
  await sleep(300);
  assert.strictEqual(received.filter((m) => m.data.msgId === 'cloud').length, 0);
  assert.ok(received.length >= before);

  // After the feeder's own reboot, its plan request is answered with the plans.
  post('event', { cmd: 'GET_FEEDING_PLAN_EVENT', msgId: 'p1' });
  await waitFor(() => received.filter((m) => m.data.cmd === 'GET_FEEDING_PLAN_EVENT').length === 2, 'second plan answer');
  const answer = received.filter((m) => m.data.cmd === 'GET_FEEDING_PLAN_EVENT')[1];
  assert.strictEqual(answer.data.plans.length, 2);

  // Capture and log are readable through the API.
  const capture = await api('GET', `/api/capture?serial=${SERIAL}&limit=1000`);
  assert.ok(capture.body.lines.some((l) => l.dir === 'in') && capture.body.lines.some((l) => l.dir === 'out'));
  assert.ok((await api('GET', '/api/log')).body.entries.length > 0);

  // A feeder may not send commands to another one, nor pose as it.
  const rogue = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, { clientId: 'AF06ROGUESERIAL00', reconnectPeriod: 0 });
  await new Promise((resolve, reject) => { rogue.on('connect', resolve); rogue.on('error', reject); });
  const beforeRogue = received.length;
  rogue.publish(`dl/PLAF301/${SERIAL}/device/event/post`, JSON.stringify({ cmd: 'DEVICE_START_EVENT', msgId: 'spoof' }));
  await sleep(300);
  assert.strictEqual(received.filter((m) => m.data.msgId === 'spoof').length, 0, 'a post under another serial must be ignored');
  assert.ok(received.length >= beforeRogue);
  rogue.publish(`dl/PLAF301/${SERIAL}/device/service/sub`, JSON.stringify({ cmd: 'MANUAL_FEEDING_SERVICE', grainNum: 9 }));
  await waitFor(() => output.includes('refused publish'), 'command to another feeder refused');
  assert.strictEqual(received.filter((m) => m.data.grainNum === 9).length, 0);
  rogue.end(true);

  // The schedule survives a restart.
  feeder.end(true);
  ws.close();
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.strictEqual(state.feeders[SERIAL].schedule.meals.length, 2);
});
