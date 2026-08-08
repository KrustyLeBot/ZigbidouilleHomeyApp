'use strict';

// Imou Ranger 2C, productId 3ARDK43R.
//
// Confirmed live against the real account (probe/imou/probe.js): closeCamera
// is the only device switch this model answers among the full candidate list
// tried (see the "notification" investigation in docs/fingerprints.md — no
// enableType worked for a push toggle on ANY camera on this account, Ranger 2C
// included). No PIR/motion switch either, matching what the user observed in
// the Imou Life app: only privacy and notifications are offered for this
// model, and the app's own notification setting has no API equivalent.
//
// CAVEAT: the camera was offline during the sweep, so this is confirmed only
// for closeCamera; re-run the probe once it is back up if a switch seems to be
// missing here.

const PRODUCT_ID = '3ARDK43R';

const SWITCHES = [{ capability: 'privacy_mode', enableType: 'closeCamera' }];

module.exports = { PRODUCT_ID, SWITCHES, hasBattery: false };
