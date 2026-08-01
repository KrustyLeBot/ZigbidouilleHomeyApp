'use strict';

const Homey = require('homey');
// Uncomment while debugging a new Zigbee device to dump every frame the app
// sends/receives to the app logs. Very noisy — leave off in normal use.
// const { Cluster, debug } = require('zigbee-clusters');

const errlog = require('./lib/errlog');

class ZigbidouilleApp extends Homey.App {
  async onInit() {
    // debug(true); // pair with the line above to trace raw Zigbee traffic
    // Restores the log persisted by the previous run, so evidence from a
    // pairing that crashed the app is still readable in the settings page.
    errlog.init(this.homey);
    errlog.info('app', 'Zigbidouille started');
    this.log('Zigbidouille started');

    this.registerVacuumFlows();
    this.registerDevialetFlows();
    this.registerRemoteFlows();
  }

  // The dimmer fires one trigger for every button event; this listener is what
  // narrows a flow down to the button and the kind of press it asked for.
  // Without it the card would run on every button of the remote.
  registerRemoteFlows() {
    this.homey.flow
      .getDeviceTriggerCard('hue_dimmer_pressed')
      .registerRunListener((args, state) => args.button === state.button && args.action === state.action);
  }

  // "Set the source" is the card that makes the speakers actually useful in a
  // flow — switching to the right speaker's jack, or back to Spotify.
  registerDevialetFlows() {
    this.homey.flow
      .getActionCard('devialet_set_source')
      .registerRunListener(({ device, source }) => device.selectSource(source));

    this.homey.flow
      .getActionCard('devialet_volume_step')
      .registerRunListener(({ device, delta }) => device.stepVolume(Number(delta)));
  }

  // Flow cards for the miIO vacuum (drivers/x20plus). Zigbee drivers here need
  // none: their capabilities give Homey the standard cards for free. The vacuum
  // exposes actions with no matching capability, so they are wired by hand.
  registerVacuumFlows() {
    // Two explicit resume actions, deliberately. From a paused dock-return,
    // sending "resume cleaning" starts a brand-new clean of the whole home, so
    // the flow author picks — the app never guesses.
    const actions = {
      start_cleaning: (device) => device.startCleaning(),
      resume_cleaning: (device) => device.resumeCleaning(),
      resume_returning: (device) => device.resumeReturning(),
      pause: (device) => device.pause(),
    };

    for (const [card, run] of Object.entries(actions)) {
      this.homey.flow.getActionCard(card).registerRunListener(({ device }) => run(device));
    }

    // Conditions read the capability, never an instance variable: it holds the
    // displayed state, is refreshed every poll, and matches the ids the cards
    // offer. A condition once compared a raw status code to a state id and
    // silently never matched.
    this.homey.flow
      .getConditionCard('is_paused_from')
      .registerRunListener(({ device, reason }) => device.getCapabilityValue('vacuum_status') === `paused_${reason}`);

    this.homey.flow
      .getConditionCard('status_is')
      .registerRunListener(({ device, status }) => device.getCapabilityValue('vacuum_status') === status);
  }
}

module.exports = ZigbidouilleApp;
