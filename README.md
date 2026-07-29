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
- **First device: Heiman HS-720ES CO detector** (`co-hs720es`) — a worked
  example of the common alarm-sensor pattern: the IAS Zone cluster mapped to the
  `alarm_co` / `alarm_battery` / `measure_battery` capabilities. Clone it to
  adopt the next device.
- **Built on the official SDK** — [`homey-zigbeedriver`](https://athombv.github.io/node-homey-zigbeedriver/)
  and [`zigbee-clusters`](https://github.com/athombv/node-zigbee-clusters), the
  same libraries Athom's own apps use. No raw frame parsing.

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

1. **Pair the device once** so Homey sees it, then open **Homey Developer Tools →
   Zigbee** and note its `manufacturerName`, `productId`, endpoints and clusters.
2. **Copy** an existing driver (e.g. `app/drivers/co-hs720es`) to
   `app/drivers/<your-device>`.
3. **Paste the fingerprint** into that driver's `zigbee` block in
   [app/app.json](app/app.json).
4. **Map clusters → capabilities** in the driver's `device.js`.
5. `homey app validate` → `homey app run` → re-pair. The device now binds to your
   driver.

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
    zigbee-device.js       shared base class (capability migration, safe logging)
    errlog.js              in-memory error ring, surfaced in the settings page
  drivers/
    co-hs720es/            Heiman HS-720ES CO detector (first device) — clone per new device
  locales/                 en.json / fr.json
  settings/                app settings page (errors panel)
docs/                      fingerprints of devices already interviewed
CLAUDE.md                  conventions + the device-adoption workflow + hard rules
INSTALL.md                 install steps and CLI/Node gotchas
```

## Credits

- Zigbee SDK: [athombv/node-homey-zigbeedriver](https://github.com/athombv/node-homey-zigbeedriver)
  and [athombv/node-zigbee-clusters](https://github.com/athombv/node-zigbee-clusters).
- Fingerprint hunting is easiest with the [Zigbee2MQTT device database](https://www.zigbee2mqtt.io/supported-devices/)
  as a cross-reference for what clusters a given model speaks.
