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
    const manifest = this.driver.manifest || {};

    // Multi-sub-device drivers (zigbee.devices) give each sub-device its OWN
    // capability list; the root manifest.capabilities does not represent them,
    // so syncing every sub-device to it would strip/inject the wrong ones. The
    // per-sub-device migration is left to that driver. Skip here.
    if (manifest.zigbee && manifest.zigbee.devices) return;

    // The driver manifest carries the up-to-date capability list; an old paired
    // device may be missing the newer ones. addCapability inherits the
    // capability definition from the manifest.
    const wanted = manifest.capabilities || [];

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

  // Breadcrumb into the same log the settings page shows. Use for the steps of
  // init/pairing, so a failure has visible context instead of appearing alone.
  note(context, message) {
    this.log(context, message);
    errlog.info(`${this.getName()}: ${context}`, message);
  }

  // Same, but only when verbose logging is switched on in the app settings.
  //
  // These are the step-by-step breadcrumbs that cracked the endpoint-mapping
  // and reporting bugs. They are far too noisy for normal running — several
  // lines per device on every restart — but they are exactly what is wanted
  // when bringing up a NEW device, so they stay in the code, switched off.
  // Toggle: app Settings -> Verbose logging (takes effect immediately, no
  // reinstall).
  debugNote(context, message) {
    if (!errlog.verbose()) return;
    this.note(context, message);
  }

  // Dump this node's endpoints + clusters as plain JSON, so a device's Zigbee
  // interview can be read from the app settings page instead of copied by hand
  // from Homey's Zigbee developer tool. Generic: works for any driver here.
  async describeNode() {
    const info = {
      name: this.getName(),
      driverId: this.driver.id,
      subDeviceId: this.getData().subDeviceId || null,
      endpoints: {},
    };

    // Preferred source: the zclNode homey-zigbeedriver built, which exposes the
    // bound clusters by readable name together with their numeric IDs.
    const zcl = this.zclNode;
    if (zcl && zcl.endpoints) {
      for (const [epId, ep] of Object.entries(zcl.endpoints)) {
        const clusters = ep && ep.clusters ? ep.clusters : {};
        info.endpoints[epId] = {
          clusters: Object.entries(clusters).map(([name, inst]) => ({
            name,
            id: inst && inst.constructor ? inst.constructor.ID : undefined,
          })),
        };
      }
    }

    // Supplement: the raw node descriptor from ManagerZigBee carries input /
    // output cluster IDs, including clusters the driver never bound.
    try {
      const node = await this.homey.zigbee.getNode(this);
      const eps = node && node.endpoints ? node.endpoints : {};
      for (const [epId, ep] of Object.entries(eps)) {
        const slot = info.endpoints[epId] || (info.endpoints[epId] = {});
        if (Array.isArray(ep.clusters)) slot.inputClusterIds = ep.clusters;
        if (Array.isArray(ep.bindings)) slot.outputClusterIds = ep.bindings;
      }
    } catch (err) {
      info.rawNodeError = err.message;
    }

    return info;
  }
}

module.exports = ZigbidouilleDevice;
