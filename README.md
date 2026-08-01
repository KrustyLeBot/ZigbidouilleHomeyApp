# Zigbidouille — Homey app for orphan Zigbee devices

A Homey app for **Zigbee devices that don't have a dedicated Homey app** — the
cheap sensors, plugs and switches that pair as a nameless "generic Zigbee device"
(or refuse to pair at all) because no developer ever wrote a driver for them.

Zigbidouille is that missing driver, per device. Each unsupported model gets a
small driver that maps its Zigbee clusters onto proper Homey capabilities, flow
cards and Insights — the same first-class experience a supported device gets.

Everything runs **locally** on Homey Pro's own Zigbee radio. No cloud, no bridge,
no account, no token.

The app is bilingual (English / French): it follows Homey's language. Internal
identifiers are English; only the display names are translated.

## What it does

- **Adopts unsupported Zigbee devices** — you pair the device, it binds to a
  Zigbidouille driver that knows its clusters, and it shows up as a normal Homey
  device with working tiles and flow cards.
- **Built on the official SDK** — [`homey-zigbeedriver`](https://athombv.github.io/node-homey-zigbeedriver/)
  and [`zigbee-clusters`](https://github.com/athombv/node-zigbee-clusters), the
  same libraries Athom's own apps use. No raw frame parsing.
- **A built-in Zigbee dump** in the app settings — lists every endpoint and
  cluster of each paired device, so a new device can be interviewed from the app
  itself instead of transcribing Homey's developer tools by hand.

## Supported devices

### Heiman HS-720ES — carbon monoxide detector (`co-hs720es`)

Battery detector using the standard IAS Zone alarm pattern: `alarm_co`,
`alarm_battery`, `measure_battery`. CO alarms arrive as a push notification the
moment the detector fires. A good template for any Zigbee alarm sensor.

### Shelly EM Gen4 — 2-channel energy meter + dry contact (`shelly-em-gen4`)

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

## Adopting a new device (the short version)

Full detail — including how to read a device's clusters — is in
[CLAUDE.md](CLAUDE.md).

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

- Homey Pro (SDK 3, local platform) with a built-in Zigbee radio.
- The device physically in Zigbee range during pairing.
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
  app.js                   registers app-wide flow cards
  app.json                 manifest: capabilities, drivers, Zigbee fingerprints, flow
  lib/
    zigbee-device.js       shared base class (capability migration, node dump, logging)
    errlog.js              rolling log, persisted so it survives an app restart
  drivers/
    co-hs720es/            Heiman HS-720ES CO detector
    shelly-em-gen4/        Shelly EM Gen4 (3 sub-devices from one node)
  locales/                 en.json / fr.json
  settings/                app settings page: log + Zigbee dump
docs/                      fingerprints of devices already interviewed
CLAUDE.md                  conventions + the device-adoption workflow + hard rules
INSTALL.md                 install steps and CLI/Node gotchas
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
