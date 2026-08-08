'use strict';

// Imou Open Platform HTTP client (https://open.imoulife.com).
//
// The only CLOUD transport in this app, and a deliberate exception to the
// "everything runs locally" rule: privacy mode, PIR detection and the
// notification switches live nowhere but the Imou cloud. ONVIF and the Dahua
// protocol reach the video stream and the motion events, never these settings.
//
// No dependencies — https + crypto only, like lib/miio-client.js. This file is
// the canonical copy; probe/imou/imou-client.js mirrors it.

const https = require('https');
const crypto = require('crypto');

// Data centres, from the platform's own development specification. A request
// sent to the wrong one authenticates fine and then reports no devices at all,
// which reads exactly like an empty account — hence discoverHost() below.
const HOSTS = [
  'openapi-fk.easy4ip.com', // Central Europe
  'openapi-sg.easy4ip.com', // East Asia
  'openapi-or.easy4ip.com', // Western America
  'openapi.easy4ip.com', // default / China
];

// The platform rejects a request whose clock is more than 5 minutes out, and
// refuses a nonce reused inside the same window.
const TOKEN_MARGIN = 5 * 60 * 1000; // renew this early rather than racing expiry
const REQUEST_TIMEOUT = 15000;

class ImouError extends Error {
  constructor(method, code, msg) {
    super(`${method}: ${msg} (${code})`);
    this.name = 'ImouError';
    this.code = String(code);
  }
}

class ImouClient {
  constructor({ appId, appSecret, host = HOSTS[0] }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.host = host;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  // "time:<t>,nonce:<n>,appSecret:<s>", MD5, lowercase hex. The order of the
  // three pairs is part of the contract; swapping any two yields a valid-looking
  // 32-char string that the platform simply rejects.
  sign(time, nonce) {
    const raw = `time:${time},nonce:${nonce},appSecret:${this.appSecret}`;
    return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
  }

  // One raw call. `params` is merged as-is; callers that need the token use
  // request() instead, which injects it.
  call(method, params = {}) {
    const time = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const body = JSON.stringify({
      system: { ver: '1.0', appId: this.appId, sign: this.sign(time, nonce), time, nonce },
      id: crypto.randomUUID(),
      params,
    });

    const options = {
      host: this.host,
      port: 443,
      path: `/openapi/${method}`,
      method: 'POST',
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            // An HTML error page from a proxy or a wrong path lands here. Report
            // the status, not the body: the body can be a page of markup.
            reject(new Error(`${method}: HTTP ${res.statusCode}, response was not JSON`));
            return;
          }

          const result = (parsed && parsed.result) || {};
          // The platform answers 200 with the real outcome in result.code, as a
          // STRING. Checking res.statusCode alone treats every failure as a
          // success and hands back an empty data object.
          if (String(result.code) !== '0') {
            reject(new ImouError(method, result.code, result.msg || 'unknown error'));
            return;
          }
          resolve(result.data || {});
        });
      });

      req.on('timeout', () => req.destroy(new Error(`${method}: timed out`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  // Tokens last 3 days. The platform asks that they be reused rather than
  // re-requested, and the daily call budget is small enough that it matters.
  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const data = await this.call('accessToken');
    this.token = data.accessToken;
    this.tokenExpiresAt = Date.now() + Number(data.expireTime || 0) * 1000 - TOKEN_MARGIN;
    return this.token;
  }

  // Every endpoint but accessToken itself takes the token as a param.
  async request(method, params = {}) {
    const token = await this.accessToken();
    try {
      return await this.call(method, { token, ...params });
    } catch (err) {
      // A token can be invalidated server-side before it expires (another
      // client asking for one, a credential change). Retry once with a fresh
      // one rather than surfacing a spurious auth failure to the user.
      if (err instanceof ImouError && TOKEN_ERRORS.has(err.code)) {
        this.token = null;
        const retry = await this.accessToken();
        return this.call(method, { token: retry, ...params });
      }
      throw err;
    }
  }

  // --- endpoints ---

  // Cameras added in the Imou Life (easy4ip) phone app are shared to the
  // developer account, and this is the list that shows them. deviceOpenList is
  // the other half — devices bound directly to the developer account — so both
  // are read and merged; a camera appears in one or the other, not both.
  async devices() {
    const params = { bindId: 1, limit: 50, type: 'bindAndShare', needApInfo: false };
    const found = new Map();

    for (const method of ['deviceBaseList', 'deviceOpenList']) {
      let data;
      try {
        data = await this.request(method, params);
      } catch (err) {
        // An account with no devices of one kind can refuse the matching list
        // rather than return an empty one. Only a total failure is worth
        // raising, so keep going and let the caller judge the merged result.
        continue;
      }
      for (const device of data.deviceList || []) {
        if (device && device.deviceId) found.set(device.deviceId, device);
      }
    }

    return [...found.values()];
  }

  // The heart of it: which switches this particular camera actually implements.
  // Reading a switch the model does not have returns an error, so the ability
  // list is what keeps a driver from declaring a capability that can never hold
  // a value — a tile stuck on "-" forever.
  async abilities(deviceId, channelId = '0') {
    const data = await this.request('listDeviceAbility', {
      deviceList: [{ deviceId, channelList: channelId }],
    });
    return data.deviceList || [];
  }

  async getSwitch(deviceId, enableType, channelId = '0') {
    const data = await this.request('getDeviceCameraStatus', {
      deviceId,
      channelId,
      enableType,
    });
    // Reported as the strings "on"/"off", not a boolean.
    return data.status === 'on';
  }

  async setSwitch(deviceId, enableType, enable, channelId = '0') {
    await this.request('setDeviceCameraStatus', {
      deviceId,
      channelId,
      enableType,
      enable: Boolean(enable),
    });
  }

  // Battery-powered models only (the solar Cell PT here). Mains cameras answer
  // with an error, which is why this is never called on them.
  async powerInfo(deviceId) {
    return this.request('getDevicePowerInfo', { deviceId });
  }

  // Online state for up to 8 cameras in ONE call — the platform's per-device
  // deviceOnline endpoint does not batch, but deviceBaseDetailList does, and
  // its status field covers the same ground. Worth using for that alone: the
  // account's whole free monthly quota is 30,000 requests, shared by every
  // camera, and polling 5 cameras individually every cycle was the single
  // biggest cost in the original design (see lib/imou-account.js).
  //
  // Statuses are 'online' | 'offline' | 'sleep' | 'upgrading'. Only 'offline'
  // counts as down: solar/battery cameras (the Cell PT) sit in 'sleep'
  // routinely to save power, and their switches still read fine while there
  // (confirmed live). Firmware upgrades are likewise expected, not a fault.
  // Reads returned as `false` for any deviceId not found in the reply.
  async deviceStatusList(deviceIds) {
    const out = new Map();
    if (!deviceIds.length) return out;

    const data = await this.request('deviceBaseDetailList', {
      deviceList: deviceIds.map((id) => ({ deviceId: id, channelList: '0' })),
    });
    for (const device of data.deviceList || []) {
      out.set(device.deviceId, device.status !== 'offline');
    }
    return out;
  }

  // Finds the data centre holding the account, by asking each for a token. Only
  // the right one answers, so this doubles as a credential check. Returns the
  // host; callers should persist it and stop paying for the search.
  static async discoverHost(appId, appSecret) {
    const failures = [];

    for (const host of HOSTS) {
      const client = new ImouClient({ appId, appSecret, host });
      try {
        await client.accessToken();
        return host;
      } catch (err) {
        failures.push(`${host}: ${err.message}`);
      }
    }

    throw new Error(`no Imou data centre accepted these credentials\n  ${failures.join('\n  ')}`);
  }
}

// Codes that mean "this token is no longer good", as opposed to a genuine
// refusal. Retrying anything else would just burn the daily call budget.
const TOKEN_ERRORS = new Set(['TK1002', 'TK1001', 'SN000']);

module.exports = { ImouClient, ImouError, HOSTS };
