'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const errlog = require('./errlog');

// Shared base for every driver in this app. Extend it instead of ZigBeeDevice
// directly, so the capability-migration and error-surfacing behaviour is the
// same everywhere and a new driver gets it for free.
//
// A concrete driver's device.js does its cluster→capability mapping in
// onNodeInit AFTER calling super.onNodeInit(...) — see drivers/generic-onoff.
class ZigbidouilleDevice extends ZigBeeDevice {
  async onNodeInit(payload) {
    // Devices paired before a capability was added to the driver keep their old
    // capability list (Homey caches it at pairing). Add any missing ones so new
    // features appear without the user removing and re-pairing the device.
    await this.migrateCapabilities();
    await super.onNodeInit(payload);
  }

  async migrateCapabilities() {
    // The driver manifest carries the up-to-date capability list; an old paired
    // device may be missing the newer ones. addCapability inherits the
    // capability definition from the manifest.
    const wanted = (this.driver.manifest && this.driver.manifest.capabilities) || [];

    for (const cap of wanted) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error(`addCapability ${cap}`, err);
          errlog.add(`addCapability ${cap}`, err);
        }
      }
    }

    // Drop capabilities the manifest no longer declares. A device paired before
    // one was removed keeps it forever otherwise, and the device page then walks
    // a capability with no definition and crashes.
    for (const cap of this.getCapabilities()) {
      if (!wanted.includes(cap)) {
        try {
          await this.removeCapability(cap);
        } catch (err) {
          this.error(`removeCapability ${cap}`, err);
          errlog.add(`removeCapability ${cap}`, err);
        }
      }
    }
  }

  // Record and re-throw is rarely what you want during binding; record and
  // continue keeps one broken capability from taking down the whole device.
  // Call from a driver when a non-critical registration fails.
  recordError(context, err) {
    this.error(context, err);
    errlog.add(context, err);
  }
}

module.exports = ZigbidouilleDevice;
