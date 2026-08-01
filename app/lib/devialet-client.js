'use strict';

// Local REST client for Devialet speakers: http://<ip>/ipcontrol/v1, no auth.
//
// A client holds EVERY speaker of one system, not a single address. The API's
// `{systemId}` / `{groupId}` only accept the literal "current", which resolves
// to the system of whichever speaker receives the request — so any member can
// answer for the whole system, and a request that fails on one is simply
// replayed on the next. For a stereo pair that means one speaker being asleep
// or having changed IP does not take the tile down.

const API_PATH = '/ipcontrol/v1';
const TIMEOUT = 5000;

class DevialetClient {
  // members: [{ address, role, deviceId, serial }]
  constructor(members = [], { timeout = TIMEOUT, log = () => {} } = {}) {
    this.members = members.filter((m) => m && m.address);
    this.timeout = timeout;
    this.log = log;
  }

  setMembers(members) {
    this.members = (members || []).filter((m) => m && m.address);
  }

  get addresses() {
    return this.members.map((m) => m.address);
  }

  async request(endpoint, method = 'GET', body = null) {
    if (!this.members.length) throw new Error('no known address for this system');

    let lastError;
    for (const member of this.members) {
      try {
        const result = await this._once(member.address, endpoint, method, body);
        // Whoever answered goes first next time: no point starting from a
        // speaker that is currently unreachable on every single call.
        this._promote(member);
        return result;
      } catch (err) {
        lastError = err;
        this.log(`devialet: ${member.address} failed for ${endpoint}: ${err.message}`);
      }
    }
    throw lastError;
  }

  _promote(member) {
    const i = this.members.indexOf(member);
    if (i > 0) this.members.unshift(...this.members.splice(i, 1));
  }

  async _once(address, endpoint, method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`http://${address}${API_PATH}${endpoint}`, {
        method,
        signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!res.headers.get('content-type')?.includes('application/json')) return null;
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // --- state ---

  getSystem() {
    return this.request('/systems/current');
  }

  getVolume() {
    return this.request('/systems/current/sources/current/soundControl/volume');
  }

  getCurrentSource() {
    return this.request('/groups/current/sources/current');
  }

  getSources() {
    return this.request('/groups/current/sources');
  }

  // --- commands ---

  setVolume(percent) {
    const volume = Math.max(0, Math.min(100, Math.round(percent)));
    return this.request('/systems/current/sources/current/soundControl/volume', 'POST', { volume });
  }

  // The device steps by a fixed 5% — the step is not configurable.
  volumeUp() {
    return this.request('/systems/current/sources/current/soundControl/volumeUp', 'POST', {});
  }

  volumeDown() {
    return this.request('/systems/current/sources/current/soundControl/volumeDown', 'POST', {});
  }

  playback(action) {
    return this.request(`/groups/current/sources/current/playback/${action}`, 'POST', {});
  }

  // Playing a specific source is also how the input is switched.
  playSource(sourceId) {
    return this.request(`/groups/current/sources/${sourceId}/playback/play`, 'POST', {});
  }

  powerOff() {
    return this.request('/systems/current/powerOff', 'POST', {});
  }
}

module.exports = DevialetClient;
