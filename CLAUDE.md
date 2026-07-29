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
