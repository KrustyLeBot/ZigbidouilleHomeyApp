'use strict';

// Imou Cell PT (solar), productId dfY8skkH.
//
// closeCamera (privacy) confirmed live and stable. Battery reads via
// getDevicePowerInfo's electricitys[].electric — present on 3 of the 4 at
// probe time; the 4th answered with no battery entry rather than an error,
// which reads as "the solar panel is topping it up right now", not as a
// fault, so a missing reading is skipped rather than written as 0.
//
// motion_detection is `mobileDetect`, established by diffing a real on/off
// cycle rather than by picking the best-sounding name — see the note in
// docs/fingerprints.md. `alarmPIR` is the trap: it moves in lockstep when the
// APP toggles detection (the app writes both), so reading it looks correct,
// but writing it alone changes nothing the app acknowledges. `mobileDetect`
// written alone does flip the app's own toggle, and follows manual changes
// back. `motionDetect`, despite the name, stays off throughout and is unrelated.

const PRODUCT_ID = 'dfY8skkH';

const SWITCHES = [
  { capability: 'privacy_mode', enableType: 'closeCamera' },
  { capability: 'motion_detection', enableType: 'mobileDetect' },
];

module.exports = { PRODUCT_ID, SWITCHES, hasBattery: true };
