'use strict';

// Finds Devialet speakers on the LAN and interrogates their local API — no IP
// to look up by hand, no dependencies (dgram + the built-in fetch only).
//
// Two steps:
//   1. mDNS: ask 224.0.0.251:5353 who answers for _devialet-http._tcp.local
//   2. HTTP: for each address found, read the device / system / sources state
//
// Usage:
//   node discover.js            discover, then dump each speaker's state
//   node discover.js <ip> ...   skip discovery, interrogate these addresses

const dgram = require('dgram');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_devialet-http._tcp.local';
const LISTEN_MS = 4000;
const API_PATH = '/ipcontrol/v1';

// --- minimal DNS wire format ---------------------------------------------

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const out = [];
  for (const p of parts) {
    out.push(p.length);
    for (const b of Buffer.from(p, 'utf8')) out.push(b);
  }
  out.push(0);
  return Buffer.from(out);
}

function buildQuery(name, type = 12) { // 12 = PTR
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id 0: mDNS ignores it
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(1, 4); // one question
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, encodeName(name), q]);
}

// Names can be compressed as a pointer to an earlier offset, so parsing needs
// the whole message, not just the current slice.
function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let next = offset;

  for (let guard = 0; guard < 128; guard++) {
    if (offset >= buf.length) break;
    const len = buf[offset];
    if (len === 0) { offset += 1; if (!jumped) next = offset; break; }

    if ((len & 0xc0) === 0xc0) { // pointer
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) next = offset + 2;
      offset = ptr;
      jumped = true;
      continue;
    }

    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString('utf8'));
    offset += 1 + len;
    if (!jumped) next = offset;
  }

  return { name: labels.join('.'), offset: next };
}

function parseRecords(buf) {
  const records = [];
  try {
    const counts = [buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
    let offset = 12;

    // questions
    const qd = buf.readUInt16BE(4);
    for (let i = 0; i < qd; i++) {
      offset = readName(buf, offset).offset + 4;
    }

    for (const count of counts) {
      for (let i = 0; i < count; i++) {
        const r = readName(buf, offset);
        offset = r.offset;
        const type = buf.readUInt16BE(offset);
        const rdlength = buf.readUInt16BE(offset + 8);
        const rdata = offset + 10;
        records.push({ name: r.name, type, rdata, rdlength, buf });
        offset = rdata + rdlength;
      }
    }
  } catch (err) {
    // Truncated or unexpected packet: keep whatever parsed cleanly.
  }
  return records;
}

function parseTxt(buf, start, len) {
  const txt = {};
  let i = start;
  while (i < start + len) {
    const l = buf[i];
    const entry = buf.subarray(i + 1, i + 1 + l).toString('utf8');
    const eq = entry.indexOf('=');
    if (eq > 0) txt[entry.slice(0, eq)] = entry.slice(eq + 1);
    i += 1 + l;
  }
  return txt;
}

// --- discovery ------------------------------------------------------------

function discover() {
  return new Promise((resolve) => {
    const found = new Map(); // host -> { address, txt }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', () => {});

    socket.on('message', (msg) => {
      const records = parseRecords(msg);
      const addresses = new Map(); // hostname -> ipv4
      let txt = {};
      let matched = false;

      for (const r of records) {
        if (r.name.includes('devialet')) matched = true;
        if (r.type === 1 && r.rdlength === 4) { // A
          addresses.set(r.name, Array.from(r.buf.subarray(r.rdata, r.rdata + 4)).join('.'));
        }
        if (r.type === 16) { // TXT
          Object.assign(txt, parseTxt(r.buf, r.rdata, r.rdlength));
        }
      }

      if (!matched) return;
      for (const [host, address] of addresses) {
        found.set(host, { host, address, txt });
      }
    });

    socket.bind(0, () => {
      try { socket.setMulticastTTL(255); } catch (err) { /* ignore */ }
      const q = buildQuery(SERVICE);
      // Asked a few times: mDNS is UDP and the first packet is often missed.
      const send = () => socket.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR, () => {});
      send();
      setTimeout(send, 700);
      setTimeout(send, 1600);

      setTimeout(() => {
        socket.close();
        resolve([...found.values()]);
      }, LISTEN_MS);
    });
  });
}

// --- HTTP interrogation ---------------------------------------------------

async function get(address, endpoint) {
  const url = `http://${address}${API_PATH}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function interrogate(address) {
  console.log(`\n=== ${address} ===`);
  const device = await get(address, '/devices/current');
  console.log('/devices/current  ', JSON.stringify(device));

  const system = await get(address, '/systems/current');
  console.log('/systems/current  ', JSON.stringify(system));

  const sources = await get(address, '/groups/current/sources');
  console.log('/groups/current/sources', JSON.stringify(sources, null, 2));

  const current = await get(address, '/groups/current/sources/current');
  console.log('current source    ', JSON.stringify(current, null, 2));

  const volume = await get(address, '/systems/current/sources/current/soundControl/volume');
  console.log('volume            ', JSON.stringify(volume));

  return { address, device, system, sources };
}

(async () => {
  let addresses = process.argv.slice(2);

  if (!addresses.length) {
    console.log(`Browsing mDNS for ${SERVICE} (${LISTEN_MS / 1000}s)...`);
    const found = await discover();
    if (!found.length) {
      console.log('No Devialet speaker answered. Either mDNS is filtered on this');
      console.log('network, or the speakers are asleep. Pass IPs directly:');
      console.log('  node discover.js 192.168.1.50 192.168.1.51');
      process.exit(1);
    }
    for (const f of found) {
      console.log(`  ${f.address}  ${f.host}  ${JSON.stringify(f.txt)}`);
    }
    addresses = found.map((f) => f.address);
  }

  const results = [];
  for (const a of addresses) results.push(await interrogate(a));

  // The whole point: group speakers by system, which is what a Homey device
  // should map to — one tile per stereo pair, not one per speaker.
  console.log('\n=== systems ===');
  const systems = new Map();
  for (const r of results) {
    const id = r.device?.systemId;
    if (!id) continue;
    if (!systems.has(id)) systems.set(id, []);
    systems.get(id).push({ address: r.address, role: r.device.role, deviceId: r.device.deviceId });
  }
  for (const [id, members] of systems) {
    console.log(`system ${id}: ${members.map((m) => `${m.role}@${m.address}`).join(' + ')}`);
  }
})();
