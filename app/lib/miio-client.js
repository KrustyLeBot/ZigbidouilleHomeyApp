'use strict';

// Minimal miIO client: UDP handshake + AES-128-CBC encrypted JSON calls.
// Self-contained (only dgram + crypto) so it runs inside the Homey sandbox.

const dgram = require('dgram');
const crypto = require('crypto');

const PORT = 54321;
const HANDSHAKE_TTL = 120000; // device stamp goes stale after ~2 min

// miIO packet: 32-byte header + optional AES-encrypted JSON body.
class Packet {
  constructor(token) {
    this.header = Buffer.alloc(32);
    this.header[0] = 0x21;
    this.header[1] = 0x31;
    this.data = null;
    this.serverStamp = 0;
    this.serverStampTime = 0;

    this.token = Buffer.from(token, 'hex');
    this.key = crypto.createHash('md5').update(this.token).digest();
    this.iv = crypto.createHash('md5').update(this.key).update(this.token).digest();
  }

  get needsHandshake() {
    return !this.serverStampTime || Date.now() - this.serverStampTime > HANDSHAKE_TTL;
  }

  buildHandshake() {
    this.header.fill(0xff, 4, 32);
    this.header.writeUInt16BE(32, 2);
    return Buffer.from(this.header);
  }

  build(payload) {
    this.header.fill(0x00, 4, 8);

    // Keep the device stamp in sync, or the robot rejects the packet.
    const elapsed = Math.floor((Date.now() - this.serverStampTime) / 1000);
    this.header.writeUInt32BE(this.serverStamp + elapsed, 12);

    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.iv);
    const body = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);

    this.header.writeUInt16BE(32 + body.length, 2);

    const digest = crypto
      .createHash('md5')
      .update(this.header.subarray(0, 16))
      .update(this.token)
      .update(body)
      .digest();
    digest.copy(this.header, 16);

    return Buffer.concat([this.header, body]);
  }

  // Returns the decrypted JSON body, or null for a handshake reply.
  parse(msg) {
    msg.copy(this.header, 0, 0, 32);

    const stamp = this.header.readUInt32BE(12);
    if (stamp > 0) {
      this.serverStamp = stamp;
      this.serverStampTime = Date.now();
    }

    const body = msg.subarray(32);
    if (body.length === 0) return null;

    const digest = crypto
      .createHash('md5')
      .update(this.header.subarray(0, 16))
      .update(this.token)
      .update(body)
      .digest();

    if (!this.header.subarray(16).equals(digest)) return null; // wrong token

    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}

class MiioClient {
  constructor(address, token, { timeout = 8000 } = {}) {
    this.address = address;
    this.timeout = timeout;
    this.packet = new Packet(token);
    this.id = 0;
    this.pending = new Map();
    this.handshakeWaiters = [];

    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', () => {}); // errors surface as per-call timeouts
    this.socket.on('message', (msg) => this._onMessage(msg));
  }

  _onMessage(msg) {
    let body;
    try {
      body = this.packet.parse(msg);
    } catch (err) {
      return;
    }

    if (body === null) {
      const waiters = this.handshakeWaiters;
      this.handshakeWaiters = [];
      waiters.forEach((w) => w.resolve());
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8').replace(/\0+$/, ''));
    } catch (err) {
      return;
    }

    const entry = this.pending.get(parsed.id);
    if (!entry) return;
    this.pending.delete(parsed.id);
    clearTimeout(entry.timer);

    if (parsed.error) entry.reject(new Error(parsed.error.message || 'device error'));
    else entry.resolve(parsed.result);
  }

  handshake() {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        this.handshakeWaiters = this.handshakeWaiters.filter((w) => w !== waiter);
        reject(new Error(`handshake timeout to ${this.address}`));
      }, this.timeout);

      waiter.resolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.handshakeWaiters.push(waiter);
      this._send(this.packet.buildHandshake());
    });
  }

  _send(buf) {
    this.socket.send(buf, 0, buf.length, PORT, this.address, () => {});
  }

  _callOnce(method, params) {
    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout calling ${method}`));
      }, this.timeout);

      this.pending.set(id, { resolve, reject, timer });
      this._send(this.packet.build(payload));
    });
  }

  // The robot drops the first packet when it has been idle, so a single
  // timeout is normal rather than a failure. Retry before giving up.
  async call(method, params, { retries = 2 } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (this.packet.needsHandshake) await this.handshake();
        return await this._callOnce(method, params);
      } catch (err) {
        lastError = err;
        // Force a fresh handshake: a stale stamp makes the robot ignore us.
        this.packet.serverStampTime = 0;
      }
    }

    throw lastError;
  }

  // MIoT reads: params is an ARRAY of {did, siid, piid}.
  async getProperties(props) {
    const result = await this.call('get_properties', props);
    const out = {};
    for (const entry of result || []) {
      if (entry.code === 0) out[entry.did] = entry.value;
    }
    return out;
  }

  // MIoT actions: params is a BARE OBJECT. Wrapping it in an array makes the
  // robot reply -9999 "user ack timeout" and silently do nothing.
  async action(siid, aiid) {
    const result = await this.call('action', {
      did: `call-${siid}-${aiid}`,
      siid,
      aiid,
      in: [],
    });
    if (result && result.code !== 0) {
      throw new Error(`action ${siid}/${aiid} failed with code ${result.code}`);
    }
    return result;
  }

  destroy() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    try {
      this.socket.close();
    } catch (err) {
      // already closed
    }
  }
}

module.exports = MiioClient;
