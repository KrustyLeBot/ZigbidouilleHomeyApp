# X20+ (xiaomi.vacuum.c102gl) — probed facts

Firmware `4.5.6_1087`, probed live over local miIO.
These values come from the robot, not from a spec sheet.

## Verdict on the two conflicting specs

`homey-x20plus-recap.md` was written from the **d109gl (X20 Max)** spec and is
**wrong for this robot**. The shaarkys app's `properties_c102gl` mapping is correct.

| what | recap.md (d109gl) | actual c102gl | correct |
|------|-------------------|---------------|---------|
| status | siid 2 piid 2 | **siid 2 piid 1** | app |
| fault | siid 2 piid 3 | **siid 2 piid 2** | app |
| battery | siid 3 piid 1 | siid 3 piid 1 | both |

The recap's 21-value status table (1=Idle, 2=Charging, ... 20=WashBreak) belongs
to a different enum and must not be used.

## Real property surface

Everything else in siid 2 / siid 3 returns `code -1` (does not exist).

| siid | piid | observed | meaning |
|------|------|----------|---------|
| 2 | 1 | 6 | **status** (enum below) |
| 2 | 2 | 0 | fault (0 = no fault) |
| 2 | 3 | 3 | sweep-mop-type |
| 2 | 5 | 0 | — |
| 2 | 6 | 2 | — |
| 2 | 8 | 2 | — |
| 3 | 1 | 95 | battery % |
| 3 | 2 | 1 | charging state (1 = charging) |

Notably absent on this firmware: siid 2 piid 4 (mode) and piid 7 (clean-time).

## siid 4 — activity, area and time

Confirmed live against the Xiaomi app and by pausing each activity in turn.

| piid | meaning | values |
|------|---------|--------|
| 7 | **pending task** | `0` none · `1` whole-home clean · `3` room clean · `5` mapping · `6` paused mid-clean · `11` paused mid-return · `16` blocked mid-return |
| 3 | **cleaned area, m²** | matches the Xiaomi app exactly (app said 14 m², field read 14) |
| 2 | **cleaning time, minutes** | app said 17 min, field read 18 |
| 1 | secondary status enum | `0` idle · `1` paused · `2` cleaning · `3` returning · `6` docked · `12` error · `17` standby · `18` room clean · `21` mapping |

`4/7` is what separates the two kinds of pause: with the robot paused, it was
the ONLY field that differed between a paused clean (6) and a paused
dock-return (11). Everything else - status, charging, 4/1, 4/3, 4/4, 4/5 - read
identically in both.

It is a **pending task**, not the current motion: it holds `1` all through a
mop-mode job, including the polls where the robot sits on its dock rinsing the
mop, and only clears at the true end. That is what tells a mid-job dock visit
from a finished job — see the mop section.

### Trap: 4/3 is NOT the pause field

An earlier pass read 6 and 11 in `4/3` during two pauses and concluded it was
the "paused from" field. It is not - `4/3` is the cleaned area, and it merely
happened to be 6 m² and 11 m² at those moments. The giveaway: during a single
uninterrupted clean `4/3` climbs 0 -> 11 -> 18 -> 21, which no activity code
would do. Verify any such field against the Xiaomi app before trusting it.

## Error state (status 4)

Captured live: the robot hit an obstacle on its way back to the dock and waited
for the user.

```
17:23:38  status=5  fault=0   4/7=3    returning normally
17:23:48  status=4  fault=63  4/7=16   BLOCKED - waiting for the user
17:24:58  status=5  fault=0   4/7=3    resumed after "resume return to dock"
```

- `status 4` = blocked / error, the only status where `fault` is non-zero
- `fault 63` = the error code for this obstacle case
- `4/7 = 16` = blocked **while returning**, which makes it actionable: the fix is
  "resume return to dock", not "resume cleaning"

Treated as **active** by the app, so the running area is preserved while the
robot waits rather than being reset to 0.

## No "wheels lifted" flag exists locally

The Xiaomi app reports "wheels suspended", so the sensor exists in hardware. It
is **not** readable as a property. A full 79-property sweep (siid 1-20, piid
1-30) taken while cleaning and again while the robot was held in the air differs
in exactly four fields, all of them expected:

```
s2p1   1 -> 3    status: cleaning -> paused
s4p7   1 -> 6    activity: cleaning -> paused mid-clean
s4p1   2 -> 1    secondary status, follows the main one
s3p1  25 -> 24   battery, just drained 1%
```

Every flag candidate (`s4p16`, `s4p17`, `s4p18`, `s4p20`, `s4p25`-`s4p30`) held
at 0 throughout. Lifting the robot is byte-identical to pressing pause.

The cloud gets this via MIoT **events**, which the local miIO protocol does not
subscribe to - it only polls properties. Do not go looking for this field again.

Sweep both states and diff them with `probe/sweep.js` before adding any field.

## The robot is a rebadged Dreame

`siid 1 piid 1` reads `dreame` (piid 4 = firmware `1087`). For unidentified
fields, Dreame protocol documentation is a better reference than the Xiaomi
`vacuum.c102gl` spec.

## Status enum (siid 2 piid 1)

Confirmed by driving the robot through each state, then extended by a log of
several full **vacuum + mop** jobs (see the mop section below).

| value | state | how confirmed |
|-------|-------|---------------|
| 1 | cleaning, vacuum only | live |
| 2 | idle, no job | live, see below |
| 3 | paused — cleaning **or** dock-return, indistinguishable | live |
| 4 | blocked / error (`fault` != 0) | live |
| 5 | returning to dock | live |
| 6 | docked, charging | live |
| 7 | mopping without vacuum | **not observed**, mode never selected |
| 8 | drying the mop, hours long | log |
| 9 | washing the mop at the station | log |
| 10 | driving home to wash the mop, mid-clean | log |
| 11 | building the map (drives around, cleans nothing) | log |
| 12 | cleaning, vacuum + mop | log |
| 13 | docked, battery full | live |
| 22 | station cycle (brief, right after docking) | live |

`15 = Error` from the recap doc never appeared, including when the wheels were
lifted mid-clean. The robot uses `4` for that.

**Status 2 is idle**, not a station cycle: it shows up on the first poll after
the app restarts, and between a job ending and the robot settling on `13`, at
100 % battery with `4/1 = 0` or `17` (idle / standby). An earlier note called it
too ambiguous to name because two samples disagreed on `charging`; the mop log
has a dozen more and they all sit at the end or the start of a run.

**Status 11 is map building.** Twice the robot left the dock for 5-6 minutes at
full battery, cleaned 0 m², and came back. `4/1` read `21` and `4/7` read `5`
throughout, both of which are the Dreame "fast mapping" values.

## Charging state (siid 3 piid 2)

| value | meaning |
|-------|---------|
| 1 | on dock / charging |
| 2 | off dock, not charging |
| 5 | actively driving back to dock |

`5` appears exactly when status is `5` and clears the moment the robot docks.
It tracks *driving home*, not intent.

## The two kinds of pause: distinguishable via siid 4 piid 7

Status alone cannot tell them apart - pausing a clean and pausing a dock-return
both yield status `3` with charging `2`, byte-identical (verified by sending the
robot home, pausing it, and watching it hold for 30 s).

But `siid 4 piid 7` does distinguish them: `6` when the paused activity was
cleaning, `11` when it was the dock-return. Verified by pausing each in turn and
diffing every readable field - `4/7` was the only one that differed. The app
reads it directly, with no local tracking of the previous status.

Rejected hypothesis along the way: charging `5` looked like a "was docking"
marker, since one log showed `3`/`5` together. That sample was the robot briefly
resuming its drive, not intent being retained. `charging=5` only ever
accompanies `status=5` (actively driving home).

The app still ships **two explicit resume actions** rather than one "resume
whatever you were doing": the state is now known reliably, but a wrong resume is
destructive (see below), so the choice stays with the user's flow.

### Why this is dangerous, not just inconvenient

From `status=3` (paused), the resume you send must match what the robot was
actually doing:

- paused mid-dock-return + `siid 3 aiid 1` -> correctly continues home
- paused mid-dock-return + `siid 2 aiid 1` -> **starts a brand-new full clean
  of the whole flat**

Since a paused dock-return is indistinguishable from a paused clean, any
"smart" auto-resume will eventually pick wrong and launch a full clean by
mistake — most likely while nobody is home to stop it.

=> ship **two explicit** actions: resume cleaning, resume dock-return.
The user's flow decides which; the robot cannot. Do NOT add an auto-resume
that guesses.

## Action call format (important)

`get_properties` takes params as an **array**:

```js
call('get_properties', [{ did: 's', siid: 2, piid: 1 }])
```

`action` takes params as a **bare object** — wrapping it in an array makes the
robot reply `{"code":-9999,"message":"user ack timeout"}` and do nothing:

```js
call('action', { did: 'call-2-1', siid: 2, aiid: 1, in: [] })   // works
call('action', [{ did: 'call-2-1', siid: 2, aiid: 1, in: [] }]) // -9999
```

A `-9999 user ack timeout` therefore means *malformed request*, not *unknown
action*. Two aiids were wrongly written off this way before the format was found.

### Verified actions

All tested live on the robot, all replied `code 0`:

| action | call | observed |
|--------|------|----------|
| start / resume cleaning | siid 2 aiid 1 | status 3 -> 1 |
| pause | siid 2 aiid 2 | status 1 -> 3, and 5 -> 3 |
| go home / resume dock-return | siid 3 aiid 1 | status 3 -> 5, charging -> 5 |

`siid 2 aiid 8` ("Continue Sweep" per the recap doc) was never validly tested —
the two attempts used the wrong param format. Untested, and not needed: aiid 1
resumes a paused clean correctly.

## Mid-clean recharge — CAPTURED, and detectable

Caught live at 15% battery, 14 m² into a clean. Full sweeps at each phase:

| field | cleaning | returning | **docked to recharge** |
|-------|----------|-----------|------------------------|
| `2/1` status | 1 | 5 | **3 (PAUSED)** |
| `3/2` charging | 2 | 5 | **1 (on dock)** |
| `4/7` activity | 1 | 1 | **1 (still cleaning)** |
| `4/17` | 0 | 0 | **1** |
| `15/3` | 0 | 0 | **1** |
| `2/2` fault | 0 | **20** | 0 |

The robot **does not report status 6/13 when it docks to recharge** - it reports
`3` (paused) while physically on the dock. `status 3 + charging 1` is therefore
the signature, and it is impossible for a finished clean. That combination is
what `toState()` maps to the `recharging` state.

`4/7` staying at `1` (cleaning) during the return is the corroborating signal:
on a normal end-of-job return it reads `0`.

Two traps found along the way:

- **`4/18` is NOT a job-pending flag.** It read 20 during the return home and
  looked promising, but fell back to 0 on docking - it is transient to the drive
  home (distance or countdown), not job state.
- **`2/2` (fault) hits 20 during a perfectly normal recharge return.** It is not
  an error code. Never gate an error state on it; the app only passes it through
  as a flow token.

Without the `recharging` state the robot would read as `paused_cleaning` while
charging, fire the "cleaning interrupted" trigger 90 s later, and any auto-resume
flow would cut the charge short.

Still unconfirmed: whether `4/17` / `15/3` return to 0 at the true end of the
job. The `status 3 + charging 1` test does not depend on them.

## Historical note: why this was thought undetectable

The robot sometimes returns to charge mid-job and resumes on its own. No probed
property flags "job pending":

- `siid 4 piid 7` is the activity code (see the siid 4 section below) - it says
  what the robot is doing, not whether a job is outstanding.
- `siid 4 piid 1` is a second status field (2 = cleaning, 3 = returning,
  6 = docked). Same information, different enum.

Sending the robot home mid-job **aborts** the job — everything returns to the
idle baseline. That is NOT the same as a self-initiated recharge, so it cannot
be used to reproduce the case. A real recharge needs the battery to actually run
low mid-clean; untested so far.

This turns out not to matter. A recharge goes `1 -> 5 -> 6 -> 1` and never
passes through `3` (paused), so the pause notifications do not fire spuriously.
Verified against the trigger logic.

If you ever catch a real mid-clean recharge, run `probe.js watch` during it —
a distinct status value there would allow an explicit "recharging" state.

## Completion trigger (task_completed)

Fires when the robot is back on the dock (status 6 or 13) AND status 1
(cleaning) was seen this cycle. The "actually cleaned" guard is essential: the
robot leaves the dock and returns on its own repeatedly at night (10 times in
one logged night, 60-750s away each), never cleaning - "reached dock" alone
would spam. Verified against a 15h log: fires once per real clean, never during
night wandering.

siid 4 piid 1 is a cleaning-progress counter (0..N over the run, holds while
docked, resets next clean) - candidate for a future progress capability.

KNOWN LIMIT: a mid-clean recharge docks with the flag still set, so it fires
once early. Needs a real recharge log to separate "docked to recharge" (low
battery, leaves again) from "docked, done". Today's logs never dropped below
80%, so the case is still uncaptured.

## End-of-job vs recharge — full cycle finally captured

A 15h log caught two complete cleans, one with a mid-clean recharge, plus a
night of wandering. Confirmed:

| phase | status | charging | 4/7 | 4/3 |
|-------|--------|----------|-----|-----|
| cleaning | 1 | 2 | 1 | climbs |
| return to recharge | 5 | 5 | **1** | held |
| **on dock recharging** | **3** | **1** | **1** | held (14) |
| resumes | 1 | 2 | 1 | climbs from 14 |
| return at end of job | 5 | 5 | **1** | final |
| station cycle | 22 | 1 | **0** | final |
| **docked, done** | 6 -> 13 | 1 | **0** | held till next clean |
| night wandering | 5 | 5 | **0** | 0 |

Two clean signals fall out of this:

- **`status 3 + charging 1` is unique to a mid-clean recharge.** End of job goes
  5 -> 22 -> 6 -> 13, never 3. This is what `toState` maps to `recharging`.
- **`4/7` is 1 on every real return, 0 on night wandering.** So
  `status 5 && 4/7 == 1` is a genuine "returning from a job", and now also arms
  `cleanedThisCycle` - a Homey restart during the drive home still notifies.
  `4/3` cannot do this: it survives docking and never resets, so a wandering
  robot still carries the previous run's area.

`task_completed` fired exactly twice over the whole log (once per real clean,
17 m2 and 18 m2), never during the recharge or the wandering. Verified by
replaying the CSV through the state machine.

## Mop mode: the station cycle, and why "docked" stopped meaning "done"

Enabling **vacuum + mop** in the Xiaomi app brought out a whole second half of
the status enum that vacuum-only runs never reach. Captured over three full mop
jobs. A job now looks like this:

```
9   wash the mop before leaving          4/7=1   on dock
12  vacuum + mop                         4/7=1
10  drive home to rinse the mop          4/7=1   charging=5
6   arrive on the dock                   4/7=1   <- mid-job!
9   wash the mop                         4/7=1
12  resume, area carries on from where it stopped
5   drive home, job over                 4/7=1
22  station cycle                        4/7=0
6   docked                               4/7=0
9   wash the mop                         4/7=0
8   dry the mop, ~4 h                    4/7=0
13  docked, charged
```

Two things break if only the status is read:

- **The robot docks in the middle of a clean**, to rinse the mop, and reports
  `6` while doing it. "On the dock" alone therefore fires `task_completed` and
  freezes `last_cleaned_area` mid-job (caught at 16 m² of a 28 m² run).
- **`status 1` is not the cleaning status any more.** With the mop on it is
  `12`, so every check written as `status === 1` silently stopped arming.

`4/7` is what separates them: it holds the pending task (`1` whole-home,
`3` room) across the entire job, dock visits included, and only drops to `0`
when the job is really over. So the rule is **on the dock AND `4/7 == 0`**,
which is what `isJobDone()` implements. `isActive()` follows the same logic, so
the running area survives a mop wash the way it already survived a recharge.

### The drying countdown lives in 2/5

During status `8`, `2/5` counts **minutes remaining** — it started at 239 and
ticked down to 0 exactly one per minute over four hours, then the robot moved to
`13`. Outside drying it reads 0. Not currently exposed as a capability.

### fault (2/2) is non-zero all through a normal drying cycle

It held `114` on one cycle and `68` on another, for hours, with nothing wrong —
`4/18` mirrored the same number. This is the third context where `2/2` is
non-zero without an error (the others: `20` during a recharge return, and the
`121` seen while docked and healthy). **`status 4` remains the only error
signal.** Never gate anything on `2/2`; it is passed through as a flow token.

### The station state sits in 4/25

`0` idle · `1` washing · `2` drying · `3` driving home to wash. It tracks the
main status exactly and adds nothing today, but it is the field to read if the
station ever needs its own capability.

(`7/9` reads 0 on every single row of every log — it is not the station field.
An earlier pass of this file said it was; miscounted CSV column.)

### The two other enums are Dreame's, and they corroborate

The robot is a rebadged Dreame, and its three status fields are the three Dreame
enums. Reading them that way is what named `8/9/10/11/12`, and the log then
confirmed each one:

| field | Dreame enum | values seen |
|-------|-------------|-------------|
| `2/1` | device state | see the status table |
| `4/1` | vacuum status | 0 idle · 1 paused · 2 cleaning · 3 returning · 6 charging · 12 error · 17 standby · 18 room clean · 21 map building |
| `4/7` | task status | 0 none · 1 whole-home · 3 room · 5 mapping · 6 paused mid-clean · 11 paused mid-return · 16 blocked mid-return |

`4/1` is a useful cross-check when a `2/1` value is ambiguous: it read `21`
(fast mapping) during every status-11 excursion and `18` (room clean) during
both status-1 runs that only covered 2 m².

## Still open

- `siid 2 piid 2` is **not** an error code. It read `3` all session, then `121`
  while the robot sat docked and healthy, `20` on a recharge return, and `114` /
  `68` for hours during a normal mop drying. Meaning unknown — do not wire it to
  error detection.
- Status `7` (mop without vacuum) is mapped from the Dreame enum but never
  observed here; select mop-only in the Xiaomi app to confirm it.
- Whether the robot ever reports `19` (wash paused) or `20` (auto-empty). This
  station has no dust bag, so `20` may simply not exist on it.
- Whether **Continue Sweep (siid 2 aiid 8)** exists. Untested: invoking an
  unknown aiid moves the robot.
