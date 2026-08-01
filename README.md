# Zigbidouille — Homey app for devices nobody else supports

A Homey app for **devices that don't have a dedicated Homey app** — the cheap
sensors, plugs and switches that pair as a nameless "generic Zigbee device" (or
refuse to pair at all), and the appliances whose vendor app collapses everything
useful into a handful of standard values.

Zigbidouille is that missing driver, per device. Each unsupported model gets a
small driver that maps whatever it speaks onto proper Homey capabilities, flow
cards and Insights — the same first-class experience a supported device gets.

**Protocol-agnostic by design.** Homey declares connectivity *per driver*, so a
single app can host several at once. Today: **Zigbee** (via the Homey radio) and
**LAN** (miIO over UDP, for the vacuum). Matter or anything else can join later
without restructuring anything — only the device layer differs, and the shared
plumbing (logging, debugging, settings) is protocol-neutral.

Everything runs **locally**. No cloud, no bridge, no account.

The app is bilingual (English / French): it follows Homey's language. Internal
identifiers are English; only the display names are translated.

## What it does

- **Adopts unsupported devices** — you pair the device, it binds to a
  Zigbidouille driver that knows how to talk to it, and it shows up as a normal
  Homey device with working tiles and flow cards.
- **Built on the official SDK** — [`homey-zigbeedriver`](https://athombv.github.io/node-homey-zigbeedriver/)
  and [`zigbee-clusters`](https://github.com/athombv/node-zigbee-clusters) for
  Zigbee. No raw frame parsing.
- **One place to debug everything** — the app settings hold a persisted log
  shared by every driver (filterable per device), a **Zigbee dump** of endpoints
  and clusters, the vacuum's **raw miIO trace**, and a **verbose logging**
  switch that applies to all protocols at once.

## Supported devices

### Heiman HS-720ES — carbon monoxide detector (`co-hs720es`) · Zigbee

Battery detector using the standard IAS Zone alarm pattern: `alarm_co`,
`alarm_battery`, `measure_battery`. CO alarms arrive as a push notification the
moment the detector fires. A good template for any Zigbee alarm sensor.

### Shelly EM Gen4 — 2-channel energy meter + dry contact (`shelly-em-gen4`) · Zigbee

One physical device exposed as **three Homey devices** from a single pairing:

| Tile | What it does |
|---|---|
| Channel A | CT clamp 1 — live power (W) and energy (kWh) |
| Channel B | CT clamp 2 — live power (W) and energy (kWh) |
| Dry contact | On/off control of an external load (e.g. a contactor) |

Each channel has a **"Whole-home meter (cumulative)"** setting. Tick it on the
clamp sitting on the main incomer: Homey then treats that channel as the house
total and subtracts every other metered device from it, showing the remainder as
"other". Leave it off for a sub-load such as heating.

The split into three devices is deliberate — Homey's `cumulative` flag is
per-device, so two clamps needing different cumulative settings cannot share
one.

### Xiaomi Robot Vacuum X20+ (`x20plus`) · LAN (miIO)

Talks to the robot **locally over the miIO protocol** (UDP, AES-128) — no cloud.
It exists because the general-purpose Xiaomi app collapses the robot's real
states into Homey's five standard vacuum values, throwing away the one
distinction that matters: **was it interrupted while cleaning, or on its way back
to the dock?** Those need different handling, and resuming the wrong one starts a
full clean of the whole home.

- A dedicated `Status` capability with the robot's real states, including the
  two the standard app merges.
- **Two separate resume actions** — *Resume cleaning* and *Resume return to
  dock*. Deliberately separate: the app never guesses which one you meant.
- Flow triggers for every stuck state, each confirmed after 90 s so a robot that
  frees itself does not notify.
- Cleaned area per run in Insights, and a raw miIO CSV export in the settings.

Needs the robot on a fixed local IP and its 32-character miIO token — see
[INSTALL.md](INSTALL.md).

Every value in this driver was reverse-engineered by probing a real robot: the
published spec is for a different variant and is **wrong** for this model. See
[FINDINGS.md](FINDINGS.md), and `probe/` for the scripts that produced it —
including `sweep.js`, which brute-forces the property space and diffs two robot
states to identify unknown fields.

## Why it exists

The Zigbee spec is standard, but device *behaviour* is not: two plugs that both
speak the On/Off cluster can disagree on endpoint numbers, reporting intervals,
metering scale, and which of a dozen `_TZ3000_*` manufacturer strings they
announce. Homey matches a pairing device to a driver by an **exact fingerprint**
(`manufacturerName` + `productId`), so a device nobody fingerprinted has no
driver and degrades to a generic node with, at best, a raw on/off toggle and no
flow support.

Zigbidouille is where you add that missing fingerprint and cluster mapping,
without forking a big vendor app.

The same reasoning applies beyond Zigbee. A vendor app that technically supports
your device but flattens what it reports is just as unusable as no app at all —
which is why the Xiaomi vacuum lives here too, speaking miIO over the LAN.

## Adopting a new device (the short version)

Full detail is in [CLAUDE.md](CLAUDE.md). The steps below are the Zigbee path; a
device on another protocol skips the fingerprint/cluster parts and implements
its own client (see `lib/miio-client.js` for how the vacuum does it), but the
shared plumbing — logging, verbose switch, settings — is the same.

0. **Check how others mapped it first** — the
   [Zigbee2MQTT converters](https://github.com/Koenkk/zigbee-herdsman-converters)
   (including open pull requests) and
   [ZHA quirks](https://github.com/zigpy/zha-device-handlers). A converter spells
   out which endpoint does what, and that is ground truth. Skipping this step on
   the Shelly EM Gen4 cost hours: its own descriptor reported the endpoints
   backwards, and the driver believed it.
1. **Pair the device once** so Homey sees it, then note its `manufacturerName`
   and `productId` from **Homey Developer Tools → Zigbee**.
2. **Copy** an existing driver (e.g. `app/drivers/co-hs720es`) to
   `app/drivers/<your-device>`.
3. **Paste the fingerprint** into that driver's `zigbee` block in
   [app/app.json](app/app.json).
4. **Map clusters → capabilities** in the driver's `device.js`.
5. `homey app validate` → `homey app install` → re-pair. The device now binds to
   your driver, and **Settings → Zigbee dump** lists its real endpoints and
   clusters to check the mapping against.

## Requirements

- Homey Pro (SDK 3, local platform); a built-in Zigbee radio for the Zigbee
  drivers.
- Zigbee devices physically in range during pairing; LAN devices reachable on
  the network (the vacuum also needs a fixed IP and its miIO token).
- Node >= 24 for the Homey CLI 4.x (see [INSTALL.md](INSTALL.md) for the Node/CLI
  version trap).

## Install

See [INSTALL.md](INSTALL.md). Short version:

```bash
cd app
npm install
homey login
homey app install
```

Then pair: **Devices → + → Zigbidouille → (your driver)**, and follow the
pairing instructions to put the device in join mode.

## Project layout

```
app/                       the Homey app
  app.js                   registers the vacuum's flow cards
  app.json                 manifest: capabilities, drivers (per-driver connectivity), flow
  lib/
    errlog.js              rolling log shared by every driver, persisted, verbose-aware
    zigbee-device.js       Zigbee base class (capability migration, node dump, logging)
    miio-client.js         miIO client: UDP handshake + AES-128 (vacuum)
    x20plus.js             the vacuum's MIoT map and state machine
    recorder.js            raw miIO CSV recorder
  drivers/
    co-hs720es/            Heiman HS-720ES CO detector          — zigbee
    shelly-em-gen4/        Shelly EM Gen4, 3 sub-devices        — zigbee
    x20plus/               Xiaomi X20+ vacuum                   — lan (miIO)
  locales/                 en.json / fr.json
  settings/                app settings: log · Zigbee dump · raw miIO log
probe/                     standalone scripts — talk to a device without Homey
  x20plus/                 the vacuum's miIO tooling (one subfolder per device)
    probe.js               watch status live / scan properties / list actions
    sweep.js               brute-force siid/piid discovery, and diff two robot states
docs/                      fingerprints of devices already interviewed
  Homey Notification.mp3   notification sound, for use in Flows (not used by the app)
FINDINGS.md                everything learned by probing the real vacuum
CLAUDE.md                  conventions + the device-adoption workflow + hard rules
INSTALL.md                 install steps and CLI/Node gotchas
.env                       robot IP + miIO token — gitignored, never commit it
```

## Credits

- Zigbee SDK: [athombv/node-homey-zigbeedriver](https://github.com/athombv/node-homey-zigbeedriver)
  and [athombv/node-zigbee-clusters](https://github.com/athombv/node-zigbee-clusters).
- [Zigbee2MQTT](https://www.zigbee2mqtt.io/supported-devices/) and its
  [converters](https://github.com/Koenkk/zigbee-herdsman-converters) — the best
  cross-reference for what a given model actually speaks. The Shelly EM Gen4
  endpoint map here comes from
  [PR #12245](https://github.com/Koenkk/zigbee-herdsman-converters/pull/12245).
- [ZHA device handlers](https://github.com/zigpy/zha-device-handlers) — same
  role on the Home Assistant side, useful when a device has no Z2M converter
  yet.
- miIO protocol reference: [rytilahti/python-miio](https://github.com/rytilahti/python-miio),
  cross-checked against [shaarkys/com.xiaomi-miio](https://github.com/shaarkys/com.xiaomi-miio).
  Token extraction: [PiotrMachowski/Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor).
