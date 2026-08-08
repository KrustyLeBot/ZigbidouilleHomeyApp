# Working on this repo

Homey app that adapts **devices with no usable Homey app of their own** — the
ones that pair as a bare "generic Zigbee device" or not at all, and the ones
whose vendor app flattens away everything worth automating. Each gets a small
driver here.

**The app is not Zigbee-only.** Homey declares `connectivity` *per driver*, so
one app can host several protocols side by side:

| Protocol | Drivers | Stack |
|---|---|---|
| `zigbee` | `co-hs720es`, `shelly-em-gen4` | [`homey-zigbeedriver`](https://athombv.github.io/node-homey-zigbeedriver/) + [`zigbee-clusters`](https://github.com/athombv/node-zigbee-clusters) — never raw frames |
| `lan` | `x20plus` (Xiaomi vacuum) | miIO over UDP + AES-128, `lib/miio-client.js`, self-contained (dgram + crypto only) |

Adding Matter or anything else means adding drivers, not restructuring: only the
device layer is protocol-specific. Everything shared — the log, the verbose
switch, the settings page — is protocol-neutral, and new code should keep it
that way. Put anything reusable in `lib/errlog.js` rather than a Zigbee-only
base class.

Everything runs locally. No cloud, no bridge, no account.

## Conventions

- **Code and comments in English.** UI strings are bilingual EN/FR via
  `app/locales/*.json` and the `title`/`hint` objects in `app.json`.
- **Internal identifiers are English** (`generic_onoff`, not `interrupteur`).
  Only display names get translated.
- Comments explain *why*, not *what*. Keep them at the density of the
  surrounding file.
- One driver = one device model (or one tight family of near-identical models).
  Resist a single "does everything" driver; see below.

## The core workflow: adopting a new device

This is the whole point of the app. To add a device:

0. **Look up how others already did it — BEFORE writing anything.** Someone has
   almost certainly mapped this device for another ecosystem, and their mapping
   is ground truth you can copy:

   - **Zigbee2MQTT** — [supported devices](https://www.zigbee2mqtt.io/supported-devices/),
     and the converter source in
     [`Koenkk/zigbee-herdsman-converters`](https://github.com/Koenkk/zigbee-herdsman-converters)
     (search the repo *and its pull requests* — new devices often live in an
     open PR before release). A converter states the endpoint→function mapping
     outright, e.g. `onOff({endpointNames: ["1"]})`,
     `electricityMeter({endpointNames: ["2","3"]})`.
   - **Home Assistant ZHA** — [`zigpy/zha-device-handlers`](https://github.com/zigpy/zha-device-handlers)
     quirks, plus its issues for devices not yet supported.
   - The HA and Zigbee2MQTT **issue trackers** are also where firmware bugs and
     workarounds for a given model are discussed.

   This is not optional polish. On the Shelly EM Gen4 the device's own simple
   descriptor advertised the endpoints **backwards**, the driver was built from
   it, and the result was hours spent "proving" that a perfectly functional
   device had broken firmware. The Zigbee2MQTT converter had the correct
   mapping the whole time and would have settled it in two minutes.

   **Where a working converter and the device's descriptor disagree, trust the
   converter** and hardcode its mapping.

1. **Interview it.** Pair the device to Homey once (it lands as an unknown /
   generic node), then read its Zigbee fingerprint:
   ```bash
   homey app run          # then in another shell, or from the Homey developer tools:
   ```
   Homey **Developer Tools → Zigbee** lists every node with its
   `manufacturerName`, `productId` (modelId), endpoints, and the input/output
   **clusters** each endpoint exposes. Write these down — they are the contract.
2. **Clone an existing driver.** Copy the closest `app/drivers/<driver>` to a new
   `app/drivers/<your-device>` and rename the class. `co-hs720es` (Heiman CO
   detector, IAS Zone → alarm capabilities) is the current worked example.
3. **Fill the fingerprint** in `app.json` under the driver's `zigbee` block:
   `manufacturerName`, `productId`, and the endpoint → `clusters` / `bindings`
   map read in step 1. Homey matches a pairing device to a driver **only** by
   this fingerprint, so it must be exact.
4. **Map clusters to capabilities** in the driver's `device.js` with
   `registerCapability(capability, CLUSTER.XXX, { ... })`.
5. `homey app validate` → `homey app run` → re-pair the device and watch it bind
   to your new driver instead of the generic node.

`docs/` collects the fingerprints of devices already interviewed — add to it
whenever you adopt a new one, so the next person does not re-interview.

6. **Update [README.md](README.md).** It is the only document that describes
   what this app supports, and it goes stale the moment a driver lands without
   it. A device is not adopted until the README says so.

   Every new driver needs, at minimum: a row in the **supported devices**
   table, a short section saying what it exposes and why the driver exists
   (what the vendor app gets wrong), and a line in the **project layout** tree
   for its `drivers/` folder and any new `lib/` files. Then check whether the
   change invalidates something stated elsewhere in it — the intro's protocol
   list, the settings-tab description, the credentials/pairing steps, and the
   credits are the parts that quietly stop being true. Adding the first cloud
   driver, for instance, falsified a flat "everything runs locally, no cloud,
   no account" claim three sections above the device list.

   The same applies to any change that alters user-visible behaviour, not only
   new drivers: new capabilities, a changed default poll interval, a new
   settings tab, a new credential to enter.

### Never rename the image files

Images must sit at the conventional paths, exactly:

```
assets/images/{small,large,xlarge}.png              250x175 / 500x350 / 1000x700
drivers/<id>/assets/images/{small,large,xlarge}.png  75x75 / 500x500 / 1000x1000
```

The mobile app resolves them **by that path**, ignoring the `images` override in
`app.json`. Renaming the files and updating the manifest therefore validates
cleanly, works in the web client, and shows a blank panel on the phone.

This was diagnosed the slow way: renaming to `-v2`/`-v3` (to defeat image
caching) blanked the mobile pairing screen, renaming back fixed it, renaming to
`device-*.png` blanked it again — a perfect correlation.

**The mobile app caches these images hard, and neither reinstalling the app nor
bumping its version evicts them.** The only thing that worked was clearing the
Homey app's cache on the phone (Android: Settings → Apps → Homey → Storage →
Clear cache — *not* "Clear data", which signs the user out).

So: change the file contents, keep the name, and clear the phone cache to see
it. Renaming is never the answer — it silently breaks the mobile lookup, and
that failure looks identical to "the image is missing".

All three sizes must exist. A missing `xlarge` also leaves the phone with
nothing to draw. Write them as RGBA (PNG colour type 6).

Content matters too: keep a **white background and a clearly contrasted device**.
An early attempt drew the device in `#F4F6F7` on white — present in the file,
invisible on screen.

### Debugging tools built into the app

Both live in the app's settings page, so nothing needs the CLI:

The settings page is three tabs: **Log**, **Zigbee**, **Vacuum (miIO)**.

- **Verbose logging** (checkbox, Log tab) — turns on the breadcrumbs:
  `debugNote()` on Zigbee devices, `errlog.debug()` anywhere else. Off by
  default because it is several lines per device per restart; **turn it on
  first when bringing up a new device**, off again once it works. Applies
  immediately, no reinstall.

  **The vacuums deliberately stay out of it.** They poll every 10 s, so mirroring
  each poll into the shared log buried every other device's breadcrumbs — and it
  was redundant, since the CSV recorder already holds the same values,
  deduplicated and persisted. They log only what the CSV cannot show: going
  unreachable, coming back, and a status value the profile does not know
  (`unknown status raw=N`, at INFO so it appears with everything switched off).
- **The log itself** is shared by every driver and filterable per device — the
  filter reads the `Device name: what happened` prefix, so keep logging in that
  shape.
- **Zigbee dump** (Zigbee tab) — endpoints and clusters of every Zigbee device
  paired to this app, as JSON. This is the interview, readable without
  transcribing Homey's developer tools.
- **Raw miIO log** (Vacuum tab) — the vacuum's per-poll CSV, and the tool that
  decoded both the mid-clean recharge and the whole mop station cycle. Separate
  from the app log on purpose: it is dense machine data meant to be exported and
  diffed, not read line by line. Every unexplained robot behaviour starts here.

The log itself is persisted, so it survives the app restart that a failed
pairing can cause.

## Hard rules — the miIO vacuum (`x20plus`)

These came from probing a real robot; the published spec for this model is for a
different variant (`d109gl`) and is **wrong** for the `c102gl`. Full detective
work in [FINDINGS.md](FINDINGS.md) — read it before touching anything
protocol-related.

### No local state that mirrors the robot

Anything the robot reports must be **read from the robot every poll**, never
remembered and reused. Local mirrors go stale across app restarts and whenever
the robot is driven from the Xiaomi app or its own button.

Flow conditions must read `getCapabilityValue('vacuum_status')`, not instance
variables. A condition once compared the raw status (`3`) to a state id
(`paused_cleaning`) and silently never matched.

### Verify field meanings against the Xiaomi app

Do not infer what a MIoT field means from a plausible-looking pattern. `4/3` was
once read as "paused from" because it happened to hold 6 and 11 during two
pauses — it is the **cleaned area**. A field that climbs during one uninterrupted
activity is a counter, not a code.

### Field map (do not mix these up)

| field | meaning |
|-------|---------|
| **`2/1`** | **status** — `1` vacuum · `12` vacuum+mop · `3` paused · `4` error · `5` returning · `6`/`13` docked · `8` drying · `9` washing · `10` returning to wash · `11` mapping · `22` emptying the bin |
| **`4/7`** | **pending task** — `0` none · `1` whole-home clean · `3` room · `5` mapping · `6` paused mid-clean · `11` paused mid-return · `16` blocked mid-return |
| **`4/3`** | **cleaned area in m²** — matches the Xiaomi app exactly |
| `4/2` | cleaning time in minutes |
| `4/1` | secondary status enum, unused by the app |
| `2/2` | fault — non-zero in plenty of healthy states, **never** an error signal on its own |
| `2/5` | minutes left on the mop drying cycle (status 8 only) |
| `2/6` | `0` mop fitted, `2` vacuum only |
| `4/25` | station — `0` idle · `1` washing · `2` drying · `3` driving home to wash |
| `15/5` | `1` while the station empties the dust bin |

### "Docked" does not mean "done", and status 1 is not "cleaning"

Both stopped being true the day vacuum+mop was enabled. The robot **returns to
its dock mid-clean** to rinse the mop and reports status `6` while sitting there,
and it cleans under status `12`, not `1`.

- "the job is over" = on the dock **and** `4/7 == 0` → `isJobDone()`
- "it is cleaning" = `CLEANING_STATUSES`, never a single value

Testing the dock alone fired `task_completed` mid-job and froze
`last_cleaned_area` at 16 m² of a 28 m² run. Testing `status === 1` alone stopped
arming completion altogether once the mop was switched on. `4/7` is the only
field that separates the two: it holds the pending task across the whole job,
dock visits included.

### Actions take a bare object, reads take an array

`get_properties` params is an **array** of `{did, siid, piid}`; `action` params
is a **bare object**. Wrapping the action in an array makes the robot reply
`-9999` and silently do nothing.

### The poll uses WATCHED, not PROPERTIES

`device.js` polls `WATCHED` (from `lib/recorder.js`), whose keys are raw dids
(`s4p3`, `s4p7`). Reading `values.clean_area` there yields `undefined` and the
capability is silently never written. Keep the two lists in sync or read the raw
did.

### Timeline booleans are toggled, never set in true/false pairs

Homey's per-device timeline only records **boolean capability changes**, and a
`true -> false` transition logs an entry too. So each state has one hidden
boolean that is **toggled** on entry (the value is meaningless) and the others
are left untouched. Setting them all true/false produced phantom "started"
events. Toggle **only when the displayed state changes**, never every poll.

### Long enum labels need uiComponent `picker`, not `sensor`

`sensor` renders in a fixed-width icon grid on mobile: anything past ~20
characters is ellipsed, and it never wraps. `picker` renders full-width and
works fine on a `setable: false` capability.

### Stuck notifications run every poll, not on state change

`updateStuckNotification()` is called on **every** poll, before the "status
changed" gate. It once lived inside `fireTriggers`, which only runs on a change —
so a pause whose transition poll was lost to a network timeout never armed its
timer and never notified.

One trigger card per stuck state (`paused_cleaning`, `paused_returning`,
`error_returning`, `error`), each named exactly like the state so the card is
looked up by state id. All share the 90 s confirm delay and the
one-notification-per-episode guard.

### Two resume actions, deliberately

`4/7` now says reliably which activity was paused, and the app still ships **two
explicit resume cards**. Resuming a paused dock-return with "resume cleaning"
starts a **full clean of the whole home** — the destructive case, most likely
with nobody there to stop it. The user's flow picks; the app never guesses. Do
not add an auto-resume.

## Hard rules (Homey Zigbee, learned the hard way elsewhere)

### The fingerprint is the only matcher

A device binds to a driver **purely** by `manufacturerName` + `productId` in the
manifest. If either is wrong the device pairs as the generic node and none of
your capability code ever runs — with no error. Copy them verbatim from the
Zigbee developer tools, including odd casing and the leading `_TZ3000_` /
`lumi.` style prefixes. Multiple manufacturer strings for the same physical
product are common: list them all in the `manufacturerName` array.

### Read cluster IDs from `zigbee-clusters`, never hardcode numbers

Use `CLUSTER.ON_OFF`, `CLUSTER.POWER_CONFIGURATION`, etc. from `zigbee-clusters`.
The manifest wants the **numeric** cluster id (6, 1, …); the code wants the
`CLUSTER` constant. Mixing them (a number where a constant is expected) fails
silently — the capability just never updates.

### A refusal and a silence are not the same evidence

When probing a device, keep these strictly apart:

- **`UNSUPPORTED_CLUSTER`** — the device *answered*, saying it does not
  implement that cluster **on that endpoint**. Real evidence.
- **A timeout** — the device said *nothing*. Proves nothing at all: it is
  usually congestion, and this app's own parallel sub-device init is a common
  cause of it.

Reading timeouts as refusals is how a wrong endpoint map got mistaken for
broken firmware. If a probe matters, run it **serialised, with a gap between
requests, and after init has settled** — these devices drop requests that
arrive in a burst, and the same read can succeed on one run and time out on the
next.

### No `configureAttributeReporting` = values that never update

This bit the Shelly EM driver: the tiles showed a correct value read once at
init, then froze forever. `registerCapability(..., { report: 'attr',
reportParser })` only makes Homey **listen**; nothing tells the device to
**send**. Without `reportOpts.configureAttributeReporting` the device stays
silent and the capability never changes again.

Two things are required, and missing either one produces the same silent
freeze:

1. `reportOpts: { configureAttributeReporting: { minInterval, maxInterval,
   minChange } }` in `registerCapability`.
2. The cluster listed in the driver's **`bindings`** array in `app.json` — a
   device cannot report an unbound cluster. It is easy to list a cluster under
   `clusters` (what the device *has*) and forget `bindings` (what it may report
   to us).

`minChange` is in **raw** cluster units, before multiplier/divisor. With a
divisor of 1,000,000 a `minChange` of 1 means 0.000001 kWh — effectively
"report constantly". Scale it from the divisor.

### Changing `bindings` requires re-pairing — reads will lie to you

Bindings are written into the **device's own binding table at pairing time**,
from the manifest. There is no runtime API for it: `ZigBeeNode` exposes only
`handleFrame`/`sendFrame`, and `configureAttributeReporting()` does not bind.
So editing `bindings` in `app.json` and reinstalling changes **nothing** for
devices already paired.

The trap is that this fails *asymmetrically*:

- **Reading an attribute does not need a binding** — so a manual read succeeds
  and everything looks healthy.
- **Receiving reports does** — so the tile takes its value once at init and
  then never moves again.

"Reads fine, never updates" is therefore the signature of a missing binding,
not of a device that refuses to report. Proven on the Shelly by logging inside
the `reportParser`: ep2 logged a report every minute, ep3 logged none at all,
until a re-pair wrote the binding.

### Battery devices sleep — configure reporting, don't poll

Most cheap Zigbee sensors are sleepy end-devices: they are unreachable between
their own scheduled reports, so a `getCapabilityValue`-style poll times out and
looks like a dead device. Bind the cluster and set **attribute reporting**
(`configureAttributeReporting`) once at pair time, then just react to the reports
that arrive. Only mains-powered devices (plugs, bulbs) tolerate polling.

Reporting config set during pairing can be lost if the device drops off and
re-joins. `ZigBeeDevice` re-applies it on `onNodeInit` when you declare it via
`registerCapability`'s `reportOpts` / `configureAttributeReporting` — prefer
that over a one-shot call in the pair handler.

### `endpoint` numbering is 1-based and device-specific

Multi-gang switches and plugs-with-metering expose several endpoints. The
capability's `endpoint` in `registerCapability` must match the physical endpoint
from the interview (often 1, but not always). Wrong endpoint = the command goes
to the void and the relay never clicks.

### Don't fight Homey over battery capability type

`measure_battery` (%) and `alarm_battery` (low-battery boolean) come from the
Power Configuration cluster (id 1) via different attributes
(`batteryPercentageRemaining` vs `batteryAlarmState`). Many devices report only
one. Declare only the capabilities the device actually feeds, or the tile sits
on "-" forever.

### Capability migration for already-paired devices

When you add a capability to a driver, devices paired before the change keep
their old capability list. Add the missing ones in `onNodeInit` (see
`lib/zigbee-device.js` `migrateCapabilities`) so features appear without the user
removing and re-pairing.

## One driver per device — why

It is tempting to write one universal driver that inspects clusters at runtime
and adds capabilities dynamically. Homey fights this: the pairing fingerprint is
static in the manifest, `addCapability`/`removeCapability` are documented as
expensive and break flows that depend on them, and a wrong dynamic guess leaves
a device half-configured with no error. A small explicit driver per model is
boring, debuggable, and what actually ships. Clone an existing driver to make
starting a new one cheap; don't reach for one runtime-generic driver.

## Checks

```bash
cd app
npm install                        # pulls homey-zigbeedriver + zigbee-clusters
homey app validate --level debug   # CLI 4.x needs Node >= 24; on Node 22 use homey@3
homey app run                      # needs Docker Desktop; live logs while pairing
```

Zigbee pairing is a radio handshake — no tokens, no accounts, nothing secret.

The **vacuum is the exception**: miIO needs the robot's IP and its 32-character
token. Those live in the device's own Homey settings (entered during pairing),
and in a gitignored `.env` at the repo root for the standalone probe scripts.
**The token is a password — never commit it, never echo it into docs or logs.**

### Probing a device directly (`probe/`)

Standalone scripts that talk to a device **without Homey in the way** — the
fastest loop for protocol work, since there is no app to reinstall. One
subfolder per device, named after its driver; see [probe/README.md](probe/README.md).
They read the repo-root `.env` for credentials.

No dependencies to install: `probe/x20plus/miio-client.js` is a copy of the
app's, which needs only `dgram` + `crypto`. (It used to pull the `miio` package
from GitHub; the scripts only ever called `call`/`handshake`/`destroy`, all of
which the app's client already provides.)

```bash
cd probe/x20plus
node probe.js          # watch status live
node probe.js scan     # dump candidate properties once, then exit
node probe.js actions  # list resume-action candidates (does NOT run them)
```

Credentials come from the repo-root `.env`; pass `<ip> <token>` before the mode
to override.

`sweep.js` is the discovery tool: it brute-forces every `siid`/`piid` in a range
and reports which ones exist, to hunt for flags the app does not know about. Its
real power is **diffing two states**:

```bash
node sweep.js > normal.txt
# put the robot in the odd state (lift it, start the mop cycle, ...)
node sweep.js > lifted.txt
node sweep.js diff normal.txt lifted.txt
```

That diff is how unknown fields get identified — far more reliable than guessing
from a published spec, which for this model is simply wrong. Note the robot
drops oversized `get_properties` requests, hence the batching in the script.
