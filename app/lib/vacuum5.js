'use strict';

// Xiaomi Robot Vacuum 5 (xiaomi.vacuum.ov31gl) MIoT map, firmware 1.2.20.
//
// Established by sweeping the live robot through every state — see
// docs/fingerprints.md. The PUBLISHED spec is wrong here in the same way the
// d109gl one is wrong for the X20+. The spec lists 1=Standby / 2=Charging /
// 4=Working / 5=Paused / 6=Returning / 15=Error / 16=Sweeping+Mopping; the robot
// also reports 7, 9, 14 and 20, and never reported 16 through a full vacuum+mop
// run. Trust the observations below, not the spec.
//
// This model shares NO field numbering with the X20+. Notably its service 4 is
// the alarm, so there is no 4/7 — the pending-task role is played by 2/3.

const { WATCHED } = require('./recorder-vacuum5');

// 2/3 is the pending task: the field that survives the whole job.
//
// Observed 100008 with the robot idle on its dock, and 100028 from the instant
// a job was launched — held unchanged across station prep, leaving the dock,
// cleaning, a manual pause, the drive home and the mop wash on the dock. That
// is exactly the role 4/7 plays on the X20+, and it is the only field that can
// separate "docked to rinse the mop mid-job" from "job finished".
//
// NOT the fault. It was mislabelled as such from the published spec; the real
// fault is 2/66, reported as {"ts":..,"fault":[0]}.
const ACTIVITY = {
  NONE: 100008, // nothing pending — idle or job over
  PENDING: 100028, // a job is under way
};

// 2/2. Values confirmed live; anything not listed reads as 'unknown' rather
// than being guessed at.
const STATUS = {
  IDLE: 1, // standby off the dock — counters frozen, NOT cleaning
  CHARGING: 2, // on the dock
  CLEANING: 4, // the actual cleaning work: this is where area and time climb
  PAUSED: 5,
  RETURNING: 6, // driving home at the end of the job
  STATION: 7, // at the station: preparing the mop, or rinsing it mid-clean
  WASHING: 9, // washing the mop at the station
  RETURNING_WASH: 20, // driving home MID-CLEAN to rinse the mop, then leaves again
  DOCKED: 14, // on the dock
};

// Both mean "physically on the dock". Two values, not one: 14 was observed with
// a job still pending (parked mid-run), 2 at the end of a completed clean.
// Treating only 14 as the dock made isJobDone() false at the very moment the
// job finished, so the completion trigger could never fire — found in a real
// overnight log, where a 57 m² run ended in status 2 with the task cleared.
const DOCK_STATUSES = [STATUS.DOCKED, STATUS.CHARGING];

// Only status 4. Confirmed over a full 57 m² run: `area` and `time` climb under
// 4 and under nothing else. Status 1 was once read as "cleaning" from the
// candidate list — it is standby, and its counters stay frozen.
const CLEANING_STATUSES = [STATUS.CLEANING];

// Every trip back to the dock. 20 is the MID-CLEAN one: the robot goes home to
// rinse the mop and sets off again, five times in one logged run. Reading it as
// the end of the job would cut a 57 m² clean short at 10 m².
const HOMEBOUND_STATUSES = [STATUS.RETURNING, STATUS.RETURNING_WASH];

const CHARGING = {
  ON_DOCK: 1,
  OFF_DOCK: 2,
};

const ACTIONS = {
  clean: { siid: 2, aiid: 1 }, // start-sweep; also resumes a paused clean
  pause: { siid: 2, aiid: 7 }, // pause-sweeping
  home: { siid: 2, aiid: 3 }, // stop-and-gocharge; also resumes a paused return
};

// 2/66, structured rather than a bare number on this firmware.
const FAULT = { siid: 2, piid: 66 };

// 2/66 arrives as a JSON STRING, not an object — verified against the live
// robot: {"ts":1786134260,"fault":[0]}. Parsing is therefore required; treating
// it as an object silently yields 0 and every fault reads as "no fault".
function readFault(value) {
  if (typeof value === 'number') return value;

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      return 0; // not JSON: nothing usable, and a fault code is only a hint anyway
    }
  }

  if (parsed && Array.isArray(parsed.fault)) return parsed.fault.find((f) => f !== 0) || 0;
  return 0;
}

// The poll returns raw dids, so read them by did — reading a friendly name
// here would yield undefined and the capability would silently never be written.
function read(values) {
  return {
    status: values.status,
    battery: values.battery,
    charging: values.charging,
    activity: values.task,
    // Drives isFinishing() — the only reliable "the job is over" signal here.
    stationMode: readStationMode(values.station),
    // 2/6 counts hundredths of a square metre; the capability is in m2.
    cleanArea: typeof values.area === 'number' ? values.area / 100 : undefined,
  };
}

// POSITIVE match, deliberately — "anything that is not NONE" is wrong here.
//
// 2/3 is not a pure task field: it is an event-code channel that also carries
// faults. Observed 2026-08-10 at 17:34:43, seconds after a completed run:
// task=210030 with fault=[210030], the same code in both. Under the old
// "!== NONE" rule that error read as "a job is pending", which made
// isJobDone() false and would have swallowed the next real completion.
//
// The trade-off is known: a task code we have never seen (a room clean, say)
// would read as "no task". That is survivable because the mid-clean mop wash —
// the case that made this field necessary at all — reports status 7 (STATION),
// which is not a dock status, so isJobDone() stays false through it on the
// status alone. Verified across three full logged runs.
function hasPendingTask(activityRaw) {
  return activityRaw === ACTIVITY.PENDING;
}

function isCleaning(status) {
  return CLEANING_STATUSES.includes(status);
}

// Physically on the dock, whatever it is doing there. Used to tell a job in
// progress from one that is over, without relying on the status being known.
function isOnDock(status) {
  return DOCK_STATUSES.includes(status);
}

function isDrivingHome(status) {
  return HOMEBOUND_STATUSES.includes(status);
}

// True while a job is under way, which is what keeps the running area on screen.
// Status alone is not enough: the robot docks mid-job to wash the mop and then
// reports WASHING while the job is still running. The pending task decides.
function isActive(status, activityRaw) {
  if (isCleaning(status) || isDrivingHome(status) || status === STATUS.PAUSED) return true;
  return hasPendingTask(activityRaw);
}

// The job is over only once the robot is on its dock with nothing pending.
// Testing the dock alone fires mid-job, since a mop wash passes through the
// dock with the task still set.
function isJobDone(status, activityRaw) {
  return DOCK_STATUSES.includes(status) && !hasPendingTask(activityRaw);
}

function toState(status, activityRaw, chargingRaw, stationMode) {
  switch (status) {
    case STATUS.CLEANING:
      return 'cleaning';
    case STATUS.IDLE:
      // Off the dock, counters frozen. Not a job state — but if a task is still
      // pending the run is merely interrupted, not over.
      return 'idle';
    case STATUS.RETURNING:
      return 'returning';
    case STATUS.RETURNING_WASH:
      // Going home mid-clean to rinse the mop; it leaves again unaided, so this
      // must never read as the end of the run.
      return 'returning_wash';
    case STATUS.WASHING:
      // Mid-job and end-of-job washes look identical here, and deliberately so:
      // what separates them is the pending task, which isJobDone() reads. There
      // is no separate display state — every id used here must exist in the
      // vacuum_status enum in app.json, or the write fails silently and the
      // tile keeps showing the previous state.
      return 'washing';
    case STATUS.STATION:
      // Covers both the pre-run mop preparation and the mid-clean rinse — the
      // robot reports the same value for each, and nothing observed separates
      // them, so the state stays honest rather than guessing.
      return 'station';
    case STATUS.PAUSED:
      // 2/3 is an event-code channel, not just a task field, and a code that is
      // neither NONE nor PENDING is the robot asking for something. Confirmed
      // 2026-08-10: it docked mid-clean at 29 m² reporting paused + charging +
      // code 210030, and the Xiaomi app showed "clean water level low" — the
      // run cannot continue until the tank is refilled by hand.
      //
      // Reading that as 'recharging' was wrong twice over: the robot is not
      // topping up its battery to resume, and nothing announces that it needs
      // help. 'error' puts it in STUCK_STATES, so the stuck notification fires
      // with the fault code as a token after the usual confirm delay.
      //
      // A first look at that same row concluded the code was harmless, because
      // the app had not surfaced the alert yet at the time it was checked.
      if (activityRaw !== ACTIVITY.NONE && activityRaw !== ACTIVITY.PENDING) return 'error';

      // Genuinely paused on the dock with nothing to report: a mid-clean top-up
      // that resumes by itself. Must not read as an interruption, or every
      // recharge notifies and flows relaunch the clean.
      if (chargingRaw === CHARGING.ON_DOCK) return 'recharging';
      return 'paused_cleaning';
    case STATUS.DOCKED:
    case STATUS.CHARGING:
      // Drying takes ~45 minutes of that dock time and the status does not
      // mention it — only the station mode does. Without this the tile read
      // "Sur la base, chargé" for the whole cycle, which was wrong twice over:
      // the robot is busy, and it is charging (78% -> 100% across the run
      // logged 2026-08-12), not charged.
      if (isFinishing(stationMode)) return 'drying';
      // On the dock either way; the pending task says whether the run is over.
      return hasPendingTask(activityRaw) ? 'charging' : 'docked';
    default:
      return 'unknown';
  }
}

const STATE_NAMES = {
  cleaning: 'cleaning',
  idle: 'idle',
  returning_wash: 'returning to wash the mop',
  recharging: 'recharging mid-clean',
  paused_cleaning: 'cleaning paused',
  paused_returning: 'return to dock paused',
  error_returning: 'blocked returning to dock',
  error: 'error',
  returning: 'returning to dock',
  washing: 'washing the mop',
  drying: 'drying the mop',
  washing_final: 'washing the mop',
  station: 'preparing at the station',
  charging: 'charging',
  docked: 'docked',
  unknown: 'unknown',
};

const STATE_EVENT = {
  cleaning: 'evt_cleaning',
  idle: 'evt_idle',
  returning_wash: 'evt_returning_wash',
  recharging: 'evt_recharging',
  paused_cleaning: 'evt_paused_cleaning',
  paused_returning: 'evt_paused_returning',
  error_returning: 'evt_error_returning',
  error: 'evt_error',
  returning: 'evt_returning',
  washing: 'evt_washing',
  drying: 'evt_drying',
  washing_final: 'evt_washing',
  station: 'evt_station',
  charging: 'evt_charging',
  docked: 'evt_docked',
  unknown: 'evt_unknown',
};

// 2/18, reported as a JSON string: { mode, runtime, total_time }.
// Only the drying mode is named, because it is the only one whose meaning is
// established. Mode 3 is the mop wash (seen both mid-clean and at the dock),
// mode 2 a brief step on arrival, mode 0 nothing — none of them load-bearing.
const STATION_DRYING = 1;

function readStationMode(value) {
  if (typeof value === 'number') return value;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed.mode === 'number' ? parsed.mode : undefined;
  } catch (err) {
    return undefined;
  }
}

// The robot's own "the job is over" signal, and the answer to a problem no
// amount of status-reading could solve.
//
// At the moment this model reaches its dock, a finished clean and a mid-clean
// stop are IDENTICAL: same status, same 2/3 code, same frozen area. Nothing
// distinguishes them yet. A timer cannot bridge that either — a real mid-clean
// recharge lasts 20-30 minutes, so any window long enough to exclude one is
// absurd, and any window short enough to be useful gets cancelled by an alert
// like the empty water tank (observed 2026-08-10: docked 17:34:13, water alert
// 17:34:43, which wiped a completion that was entirely legitimate).
//
// Drying settles it. Across three logged runs the station reaches mode 1 only
// once the whole job is done, and holds it ~45 min; the mid-clean mop rinses
// use mode 3 and never mode 1. Confirmed live by the owner watching the robot
// dry while this read mode 1.
//
// KNOWN GAP: a vacuum-only run has no mop to dry, so this would never fire.
// Every run logged so far has the mop fitted; revisit when that changes.
function isFinishing(stationMode) {
  return stationMode === STATION_DRYING;
}

// States the robot cannot leave on its own, each with a trigger card of the
// same name — the card is looked up BY state id, so these strings and the card
// ids in app.json must stay identical.
//
// Three of the four have never been observed on this firmware: it reports a
// single `5` for a pause, and nothing yet distinguishes a paused clean from a
// paused dock-return the way the X20+'s 4/7 does. They are listed anyway so
// that the day toState() can return one, the notification works with no further
// change. Listing a state that never occurs costs nothing — it simply never
// matches.
const STUCK_STATES = ['paused_cleaning', 'paused_returning', 'error_returning', 'error'];

module.exports = {
  WATCHED,
  ACTIONS,
  STATUS,
  CLEANING_STATUSES,
  CHARGING,
  ACTIVITY,
  FAULT,
  STATE_NAMES,
  STATE_EVENT,
  STUCK_STATES,
  STATION_DRYING,
  isFinishing,
  read,
  readFault,
  toState,
  isActive,
  isJobDone,
  isCleaning,
  isOnDock,
  isDrivingHome,
  hasPendingTask,
};
