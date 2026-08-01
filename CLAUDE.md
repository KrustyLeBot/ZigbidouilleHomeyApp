# Working on this repo

Homey app that adapts **Zigbee devices that have no dedicated Homey app** — the
kind that pair as a bare "generic Zigbee device" or not at all. Each unsupported
device gets a small driver here that maps its Zigbee clusters onto Homey
capabilities.

Built on the official [`homey-zigbeedriver`](https://athombv.github.io/node-homey-zigbeedriver/)
and [`zigbee-clusters`](https://github.com/athombv/node-zigbee-clusters) — never
raw Zigbee frames. No cloud, no bridge: Homey Pro's own Zigbee radio talks to the
device directly.

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

- **Verbose logging** (checkbox) — turns on the `debugNote()` breadcrumbs:
  init steps, endpoint chosen per tile, reporting setup, commands sent. Off by
  default because it is several lines per device per restart; **turn it on
  first when bringing up a new device**, off again once it works. Applies
  immediately, no reinstall.
- **Zigbee dump** (button) — endpoints and clusters of every device paired to
  this app, as JSON. This is the interview, readable without transcribing
  Homey's developer tools.

The log itself is persisted, so it survives the app restart that a failed
pairing can cause.

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

There is **no `.env`**: Zigbee pairing is a radio handshake, there are no tokens
or accounts. (The Xiaomi sibling app needs one because miIO is IP + secret token;
this one does not.)
