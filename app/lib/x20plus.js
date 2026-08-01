'use strict';

// Xiaomi Robot Vacuum X20+ (xiaomi.vacuum.c102gl) MIoT map.
// Every value here was observed on firmware 4.5.6_1087 - see FINDINGS.md.
// The published d109gl/X20-Max spec does NOT apply to this model.

const PROPERTIES = [
  { did: 'status', siid: 2, piid: 1 },
  { did: 'charging', siid: 3, piid: 2 },
  { did: 'battery', siid: 3, piid: 1 },
  { did: 'clean_area', siid: 4, piid: 3 }, // m2 cleaned this run (matches the Xiaomi app)
  { did: 'clean_time', siid: 4, piid: 2 }, // minutes elapsed this run
  { did: 'activity', siid: 4, piid: 7 }, // pending task, see ACTIVITY
];

// siid 4 piid 7 is the *pending task*, not the current motion. Verified live by
// pausing each activity in turn (only this field differs between the two kinds
// of pause) and against a full mop cycle: it holds 1 across the mid-clean mop
// wash, including the polls where the robot sits docked, and drops to 0 the
// moment the job is really over.
const ACTIVITY = {
  NONE: 0, // no job pending - idle, night wandering, or job finished
  CLEANING: 1, // whole-home clean in progress (any pause/wash included)
  SEGMENT: 3, // room/zone clean in progress
  MAPPING: 5, // building the map
  PAUSED_CLEANING: 6,
  PAUSED_RETURNING: 11,
  ERROR_RETURNING: 16, // blocked by an obstacle on the way back to the dock
};

const ACTIONS = {
  clean: { siid: 2, aiid: 1 }, // also resumes a paused clean
  pause: { siid: 2, aiid: 2 },
  home: { siid: 3, aiid: 1 }, // also resumes a paused dock-return
};

// The robot is a rebadged Dreame and 2/1 is the Dreame state enum. The values
// below were each observed live; the mop ones only appeared once vacuum+mop was
// enabled in the Xiaomi app, which is why they used to read as "unknown".
const STATUS = {
  CLEANING: 1, // vacuum only
  IDLE: 2, // off-job, off-dock or briefly at wake-up
  PAUSED: 3,
  ERROR: 4, // blocked and waiting for the user (fault != 0)
  RETURNING: 5,
  DOCKED: 6, // on the dock, still charging
  MOPPING_ONLY: 7, // mop without vacuum - not observed, mode never selected
  DRYING: 8, // drying the mop at the station, 2/5 counts the minutes left
  WASHING: 9, // washing the mop at the station
  RETURNING_WASH: 10, // driving home to wash the mop, mid-clean
  MAPPING: 11, // exploring to build the map, never cleans
  MOPPING: 12, // vacuum + mop
  CHARGED: 13, // on the dock, battery full - resting state
  STATION: 22, // brief post-dock station cycle
};

// Every status in which the robot is doing the actual cleaning work.
const CLEANING_STATUSES = [STATUS.CLEANING, STATUS.MOPPING, STATUS.MOPPING_ONLY];

const CHARGING = {
  ON_DOCK: 1,
  OFF_DOCK: 2,
  RETURNING: 5,
};

// User-facing state. The robot reports a single "paused" (3) whether it was
// cleaning or driving home; siid 4 piid 7 says which (6 vs 11), verified live
// by pausing each activity in turn. Read straight from the robot, no tracking.
function toState(status, activityRaw, chargingRaw) {
  switch (status) {
    case STATUS.CLEANING:
      return 'cleaning';
    case STATUS.MOPPING:
    case STATUS.MOPPING_ONLY:
      return 'mopping';
    case STATUS.RETURNING:
      return 'returning';
    case STATUS.RETURNING_WASH:
      // Driving home mid-clean to rinse the mop; it leaves again on its own.
      return 'returning_wash';
    case STATUS.WASHING:
      return 'washing';
    case STATUS.DRYING:
      // Hours long, on the dock, job over. 2/5 holds the minutes left.
      return 'drying';
    case STATUS.MAPPING:
      return 'mapping';
    case STATUS.IDLE:
      return 'idle';
    case STATUS.PAUSED:
      // A robot sitting ON the dock while reporting "paused" went back to
      // recharge mid-job - it resumes on its own. Observed live at 15% battery:
      // status 3 + charging 1 + 4/7 still 1 (cleaning). Must not read as an
      // interruption, or every recharge notifies and flows relaunch the clean.
      if (chargingRaw === CHARGING.ON_DOCK) return 'recharging';
      // Only paused_returning is asserted from a positive match; anything else
      // reads as paused_cleaning (display only - the two resume actions are
      // separate cards the user picks, so this never resumes the wrong task).
      return activityRaw === ACTIVITY.PAUSED_RETURNING ? 'paused_returning' : 'paused_cleaning';
    case STATUS.ERROR:
      // Blocked, waiting for the user. 4/7 says what it was doing when it got
      // stuck, so a dock-return blocked by an obstacle is actionable as such.
      return activityRaw === ACTIVITY.ERROR_RETURNING ? 'error_returning' : 'error';
    case STATUS.DOCKED:
      return 'charging';
    case STATUS.CHARGED:
      // The robot reports a distinct value when full, rather than reusing 6.
      return 'docked';
    case STATUS.STATION:
      return 'station';
    default:
      return 'unknown';
  }
}

const STATE_NAMES = {
  cleaning: 'cleaning',
  mopping: 'vacuuming and mopping',
  recharging: 'recharging mid-clean',
  paused_cleaning: 'cleaning paused',
  returning: 'returning to dock',
  returning_wash: 'returning to wash the mop',
  paused_returning: 'return to dock paused',
  washing: 'washing the mop',
  drying: 'drying the mop',
  mapping: 'building the map',
  charging: 'charging',
  docked: 'docked',
  station: 'station working',
  idle: 'idle',
  error_returning: 'blocked returning to dock',
  error: 'error',
  unknown: 'unknown',
};

// True while a job is under way, which is what keeps the running area on screen.
//
// Status alone is not enough since the mop cycle: washing the mop mid-clean
// takes the robot home and it reports DOCKED, WASHING and RETURNING_WASH while
// the job is still very much running. The pending task (4/7) is what separates
// those from the same statuses at the end of the job, so it decides here.
function isActive(status, activityRaw) {
  // ERROR counts as active: the robot is blocked mid-job, so the running area
  // must be kept rather than reset to 0 while it waits for the user.
  // A mid-clean recharge reports PAUSED on the dock and is covered too.
  if (
    CLEANING_STATUSES.includes(status) ||
    status === STATUS.RETURNING ||
    status === STATUS.PAUSED ||
    status === STATUS.ERROR
  ) {
    return true;
  }
  return activityRaw !== undefined && activityRaw !== ACTIVITY.NONE;
}

// The job is over only when the robot is on its dock with nothing pending.
// The dock check alone fires mid-clean: a mop wash passes through DOCKED with
// the task still set (observed at 16 m2 into a clean, which then resumed).
function isJobDone(status, activityRaw) {
  const atDock = status === STATUS.DOCKED || status === STATUS.CHARGED;
  return atDock && activityRaw === ACTIVITY.NONE;
}

module.exports = {
  PROPERTIES,
  ACTIONS,
  STATUS,
  CLEANING_STATUSES,
  CHARGING,
  ACTIVITY,
  STATE_NAMES,
  toState,
  isActive,
  isJobDone,
};
