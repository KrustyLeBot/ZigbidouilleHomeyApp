'use strict';

const Homey = require('homey');
// Uncomment while debugging a new Zigbee device to dump every frame the app
// sends/receives to the app logs. Very noisy — leave off in normal use.
// const { Cluster, debug } = require('zigbee-clusters');

// Registers the Tuya EF00 cluster with zigbee-clusters at boot, BEFORE
// homey-zigbeedriver builds any node's cluster instances — otherwise a paired
// Fingerbot's EF00 cluster would come back as unknown. Requiring it for the
// side effect (Cluster.addCluster) is enough; the driver requires it too.
require('./lib/tuya-cluster');

const errlog = require('./lib/errlog');
const petlibroBridge = require('./lib/petlibro-bridge');

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
    this.registerImouFlows();
    this.registerSomfyFlows();
    this.registerFingerbotFlows();
    this.registerPetlibroFlows();
    this.registerPetkitFlows();
  }

  // Petkit Pura Max 2 on our ESPHome firmware (drivers/petkit-t4). The alert
  // card is the one most flows need: its run listener applies the severity
  // filter the flow author picked.
  registerPetkitFlows() {
    const PetkitT4Device = require('./lib/petkit-t4-device');
    this.homey.flow
      .getDeviceTriggerCard('petkit_alert')
      .registerRunListener((args, state) => PetkitT4Device.alertPasses(args.min_severity, state));

    const actions = {
      petkit_clean: (device) => device.clean(),
      petkit_level: (device) => device.level(),
      petkit_bin_emptied: (device) => device.binEmptied(),
      petkit_set_auto_clean: (device, { state }) => device.setSwitch('Auto Clean', state === 'on'),
      petkit_set_block_movement: (device, { state }) => device.setSwitch('Block Movement', state === 'on'),
    };
    for (const [card, run] of Object.entries(actions)) {
      this.homey.flow.getActionCard(card).registerRunListener((args) => run(args.device, args));
    }
    this.homey.flow.getConditionCard('petkit_pet_inside')
      .registerRunListener(({ device }) => device.getCapabilityValue('litter_status') === 'pet_inside');
    this.homey.flow.getConditionCard('petkit_bin_full')
      .registerRunListener(({ device }) => Boolean(device.getCapabilityValue('alarm_litter_full')));
  }

  // Petlibro feeders (drivers/petlibro-plaf301). Triggers fire from the device
  // (lib/petlibro-feeder-device.js) as the bridge reports events; conditions
  // read capabilities, never instance state, same rule as the vacuums.
  registerPetlibroFlows() {
    const actions = {
      petlibro_feed: (device, { portions }) => device.feed(portions),
      petlibro_open_lid: (device) => device.setLid(true),
      petlibro_close_lid: (device) => device.setLid(false),
      petlibro_set_lid_mode: (device, { mode }) => device.setLidMode(mode),
      petlibro_pause_meals: (device) => device.setMealsPaused(true),
      petlibro_resume_meals: (device) => device.setMealsPaused(false),
      petlibro_show_text: (device, { text }) => device.showText(text),
      petlibro_mark_refilled: (device) => device.markRefilled(),
    };
    for (const [card, run] of Object.entries(actions)) {
      this.homey.flow.getActionCard(card).registerRunListener((args) => run(args.device, args));
    }

    const conditions = {
      petlibro_food_is_low: (device) => Boolean(device.getCapabilityValue('alarm_food_low')),
      petlibro_is_on_battery: (device) => device.getCapabilityValue('feeder_power') === 'battery',
      petlibro_lid_is_open: (device) => Boolean(device.getCapabilityValue('feeder_lid_open')),
      petlibro_is_online: (device) => device.getAvailable() && !device.getCapabilityValue('alarm_offline'),
      petlibro_outlet_is_blocked: (device) => Boolean(device.getCapabilityValue('alarm_outlet_blocked')),
      petlibro_refill_is_due: (device) => Boolean(device.getCapabilityValue('alarm_refill_due')),
    };
    for (const [card, run] of Object.entries(conditions)) {
      this.homey.flow.getConditionCard(card).registerRunListener(({ device }) => run(device));
    }

    // The bridge address/login live in app settings (Settings -> Petlibro):
    // a save there must reach the open event stream, not wait for a restart.
    this.homey.settings.on('set', (key) => {
      if (/^petlibro_/.test(key)) petlibroBridge.reconnect();
    });
  }

  // One action: make the Fingerbot press. The onoff tile covers manual/switch
  // use; this is the card a flow reaches for ("when X, click the button").
  registerFingerbotFlows() {
    this.homey.flow
      .getActionCard('fingerbot_press')
      .registerRunListener(({ device }) => device.press());
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

  // Flow cards for the miIO vacuums (drivers/x20plus, drivers/vacuum5).
  // Zigbee drivers here need none: their capabilities give Homey the standard
  // cards for free. The vacuum exposes actions with no matching capability, so
  // they are wired by hand.
  //
  // One card PER DRIVER (id prefixed x20plus_/vacuum5_, filter driver_id=...),
  // not one shared card filtered by capabilities=vacuum_status with a device
  // picker. They were briefly merged when the Vacuum 5 was added — same run
  // logic either way, so it looked like free deduplication — but every flow
  // built on the shared cards stopped firing, with no warning shown anywhere
  // in the flow editor. Not worth re-investigating why: two near-identical
  // cards is a small price for something that demonstrably works.
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

    for (const driver of ['x20plus', 'vacuum5']) {
      for (const [card, run] of Object.entries(actions)) {
        this.homey.flow.getActionCard(`${driver}_${card}`).registerRunListener(({ device }) => run(device));
      }

      // Conditions read the capability, never an instance variable: it holds
      // the displayed state, is refreshed every poll, and matches the ids the
      // cards offer. A condition once compared a raw status code to a state id
      // and silently never matched.
      this.homey.flow
        .getConditionCard(`${driver}_is_paused_from`)
        .registerRunListener(({ device, reason }) => device.getCapabilityValue('vacuum_status') === `paused_${reason}`);

      this.homey.flow
        .getConditionCard(`${driver}_status_is`)
        .registerRunListener(({ device, status }) => device.getCapabilityValue('vacuum_status') === status);
    }
  }

  // Imou cameras (drivers/imou-ranger2c, drivers/imou-cellpt). On/off pairs
  // rather than a single "set" card with a dropdown: it matches how the rest
  // of this app's action cards read in a flow, and there is no device setting
  // to keep off Homey's autogenerated flow — privacy_mode/motion_detection are
  // custom capabilities, so nothing here is free.
  registerImouFlows() {
    const actions = {
      imou_privacy_on: (device) => device.setSwitchByCapability('privacy_mode', true),
      imou_privacy_off: (device) => device.setSwitchByCapability('privacy_mode', false),
      imou_motion_on: (device) => device.setSwitchByCapability('motion_detection', true),
      imou_motion_off: (device) => device.setSwitchByCapability('motion_detection', false),
    };
    for (const [card, run] of Object.entries(actions)) {
      this.homey.flow.getActionCard(card).registerRunListener(({ device }) => run(device));
    }

    this.homey.flow
      .getConditionCard('imou_privacy_is')
      .registerRunListener(({ device }) => Boolean(device.getCapabilityValue('privacy_mode')));

    this.homey.flow
      .getConditionCard('imou_motion_is')
      .registerRunListener(({ device }) => Boolean(device.getCapabilityValue('motion_detection')));

    // Reads the inverse: the capability is alarm_offline (true == a problem,
    // which is what gives it alarm styling on the tile), the card asks the
    // friendlier "is it online".
    this.homey.flow
      .getConditionCard('imou_is_online')
      .registerRunListener(({ device }) => !device.getCapabilityValue('alarm_offline'));
  }

  // Somfy Protect alarm (drivers/somfy-alarm). Can arm/disarm/night-mode it —
  // see lib/somfy-alarm-device.js. State-change triggers fire straight from
  // the device on a poll/event that finds a new value; only the conditions
  // and the somfy_set_state action need a listener registered here.
  registerSomfyFlows() {
    this.homey.flow
      .getConditionCard('somfy_state_is')
      .registerRunListener(({ device, state }) => device.getCapabilityValue('homealarm_state') === state);

    this.homey.flow
      .getConditionCard('somfy_is_triggered')
      .registerRunListener(({ device }) => Boolean(device.getCapabilityValue('alarm_generic')));

    this.homey.flow
      .getActionCard('somfy_set_state')
      .registerRunListener(({ device, state }) => device.setSecurityLevel(state));
  }
}

module.exports = ZigbidouilleApp;
