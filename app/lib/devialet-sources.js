'use strict';

// Maps Devialet sources to the fixed ids of the `devialet_source` capability.
//
// A Homey enum capability needs a STATIC list of values, but Devialet
// `sourceId`s are UUIDv4 and are not stable — they change when the group is
// reconfigured. So the capability stores a stable id like `jack_right`, and the
// live `sourceId` is resolved on every use from `GET /groups/current/sources`.
//
// Physical inputs need the host's role to be told apart: a stereo pair exposes
// one `opticaljack` per speaker, and the API docs say to use the host `deviceId`
// for exactly this. `deviceId` -> role comes from `GET /systems/current`.

// Source types that are physical inputs, i.e. one per speaker.
const PHYSICAL = ['opticaljack', 'optical', 'line', 'phono', 'digital_left', 'digital_right'];

// Non-physical sources are hosted by a single speaker of the system but belong
// to the system as a whole, so the host role is irrelevant for them.
const NON_PHYSICAL = ['bluetooth', 'airplay2', 'spotifyconnect', 'upnp', 'raat'];

const ROLE_SUFFIX = {
  FrontLeft: 'jack_left',
  FrontRight: 'jack_right',
  Mono: 'jack',
};

// Every id the capability and the flow card can offer.
const IDS = [...NON_PHYSICAL, 'jack', 'jack_left', 'jack_right'];

function isPhysical(type) {
  return PHYSICAL.includes(type);
}

// A live source -> the stable capability id, or null when it is a type we do
// not model (rather than guessing and showing the wrong input as active).
function idForSource(source, rolesByDeviceId = {}) {
  if (!source || !source.type) return null;
  if (NON_PHYSICAL.includes(source.type)) return source.type;
  if (!isPhysical(source.type)) return null;

  const role = rolesByDeviceId[source.deviceId];
  return ROLE_SUFFIX[role] || 'jack';
}

// The stable id -> a live sourceId to POST play on, or null when that input is
// not currently offered (speaker off, group reconfigured).
function sourceIdFor(id, sources = [], rolesByDeviceId = {}) {
  const match = sources.find((s) => idForSource(s, rolesByDeviceId) === id);
  return match ? match.sourceId : null;
}

// deviceId -> role, from GET /systems/current.
function rolesFromSystem(system) {
  const roles = {};
  for (const d of (system && system.devices) || []) {
    if (d.deviceId) roles[d.deviceId] = d.role;
  }
  return roles;
}

module.exports = {
  IDS, PHYSICAL, NON_PHYSICAL, idForSource, sourceIdFor, rolesFromSystem,
};
