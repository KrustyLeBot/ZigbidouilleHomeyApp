'use strict';

const Homey = require('homey');
const errlog = require('../../lib/errlog');

const API_PATH = '/ipcontrol/v1';
const INFO_TIMEOUT = 5000;

// Pairing groups the discovered speakers by SYSTEM, so a stereo pair becomes
// ONE device holding both addresses — not two tiles fighting over one system,
// which is what listing each mDNS result separately would give.
class DevialetDriver extends Homey.Driver {
  async onPairListDevices() {
    const results = Object.values(this.getDiscoveryStrategy().getDiscoveryResults());
    errlog.info('devialet pair', `${results.length} speaker(s) announced over mDNS`);

    // Ask each speaker who it is. Done in parallel: a sleeping speaker should
    // not hold up the whole list behind its timeout.
    const speakers = (await Promise.all(results.map((r) => this.describe(r))))
      .filter(Boolean);

    const systems = new Map();
    for (const s of speakers) {
      if (!systems.has(s.systemId)) systems.set(s.systemId, []);
      systems.get(s.systemId).push(s);
    }

    const devices = [];
    for (const [systemId, members] of systems) {
      // Left first, so the stored order is stable and readable in the log.
      members.sort((a, b) => (a.role || '').localeCompare(b.role || ''));

      devices.push({
        // The system id is the identity: it survives IP changes, speaker
        // swaps and renames.
        data: { id: systemId },
        name: members[0].systemName || members[0].deviceName || 'Devialet',
        store: {
          systemId,
          systemType: members[0].systemType || 'solo',
          members: members.map((m) => ({
            address: m.address,
            role: m.role,
            deviceId: m.deviceId,
            serial: m.serial,
          })),
        },
      });

      errlog.info(
        'devialet pair',
        `system ${members[0].systemName}: ${members.map((m) => `${m.role}@${m.address}`).join(' + ')}`,
      );
    }

    return devices;
  }

  // Reads /devices/current and /systems/current so the pairing list can show a
  // real system name and group the speakers correctly.
  async describe(discoveryResult) {
    const address = discoveryResult.address;
    if (!address) return null;

    try {
      const device = await this.getJson(address, '/devices/current');
      if (!device || !device.systemId) return null;

      let system = {};
      try {
        system = await this.getJson(address, '/systems/current');
      } catch (err) {
        // Not fatal: the system name is cosmetic, grouping only needs systemId.
      }

      return {
        address,
        deviceId: device.deviceId,
        systemId: device.systemId,
        role: device.role,
        serial: device.serial,
        deviceName: device.deviceName,
        systemName: system.systemName,
        systemType: system.systemType,
      };
    } catch (err) {
      errlog.add(`devialet pair ${address}`, err);
      return null;
    }
  }

  async getJson(address, endpoint) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INFO_TIMEOUT);
    try {
      const res = await fetch(`http://${address}${API_PATH}${endpoint}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = DevialetDriver;
