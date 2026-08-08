'use strict';

// Fields the Vacuum 5 driver polls and records.
//
// Kept apart from lib/recorder.js's list, which is the X20+'s: the two robots
// share no field numbering at all, so one list cannot serve both. The Recorder
// class itself is shared and takes this as a parameter.
//
// Wider than the app strictly needs at runtime — the extra fields cost nothing
// in one batched call, and the fields that turn out to matter are never the
// ones already read. That is how the X20+'s mop cycle was eventually decoded.
//
// The `did` here is only a local label: this firmware overwrites the did in its
// reply with the robot's numeric device id. lib/miio-client.js keys the result
// by request order, so the order of this list is significant.

const WATCHED = [
  { did: 'status', siid: 2, piid: 2 }, // 1 cleaning, 4 working, 5 paused, 6 returning, 7 station prep, 9 washing, 14 docked
  { did: 'task', siid: 2, piid: 3 }, // 100008 none, 100028 job pending — the 4/7 equivalent
  { did: 'area', siid: 2, piid: 6 }, // hundredths of m2, resets at job start
  { did: 'time', siid: 2, piid: 7 }, // seconds, resets at job start
  { did: 'mop', siid: 2, piid: 11 }, // mop fitted
  { did: 'station', siid: 2, piid: 18 }, // {"mode":n} — 3 preparing, 1 idle at dock
  { did: 'dryleft', siid: 2, piid: 90 }, // minutes left on the drying cycle
  { did: 'sweepmop', siid: 2, piid: 96 },
  { did: 'fault', siid: 2, piid: 66 }, // {"ts":..,"fault":[0]}
  { did: 'battery', siid: 3, piid: 1 },
  { did: 'charging', siid: 3, piid: 2 }, // 1 on dock, 2 off dock
  // Constant through every state observed so far. Recorded because a field that
  // never moved during one session is not proof it never moves.
  { did: 's2p4', siid: 2, piid: 4 },
  { did: 's2p5', siid: 2, piid: 5 },
  { did: 's2p8', siid: 2, piid: 8 },
  { did: 's2p9', siid: 2, piid: 9 },
];

module.exports = { WATCHED };
