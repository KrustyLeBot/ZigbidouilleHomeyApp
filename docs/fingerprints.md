# Interviewed device fingerprints

The Zigbee identity of every device adopted here, copied from **Homey Developer
Tools → Zigbee** at pairing time. Homey matches a device to a driver purely by
`manufacturerName` + `productId`, so these must be exact. Add an entry whenever
you adopt a new device.

---

## Heiman HS-720ES — CO detector (driver `co-hs720es`)

> **Status: interviewed 2026-07-29.** Marketing name is "HS-720ES"; the Zigbee
> `modelId` it announces is `JM720ES-EF-3.0`. Homey matches on the modelId, so
> that is what goes in `productId`.

| field | value | confirmed? |
|-------|-------|-----------|
| `manufacturerName` | `HEIMAN` | yes |
| `productId` (modelId) | `JM720ES-EF-3.0` | yes |
| device type | `enddevice` (battery, sleepy) | yes |
| endpoint | `1` | **yes** (Zigbee dump) |
| input clusters | `0` basic, `1` power config, `3` identify, `1280` IAS Zone | **yes** (Zigbee dump, 2 units) |
| IAS `zoneType` | `0x000B` (Carbon Monoxide Sensor) | assumed |

Raw interview row: IEEE `b0:e8:e8:ff:fe:65:f8:f7`, NWK `51717 (CA05)`,
`enddevice`, battery ~10%.

---

## Shelly EM Gen4 — 2-channel energy meter + dry contact (driver `shelly-em-gen4`)

> **Status: fully working 2026-07-30** — both CT channels metering, relay
> switching, reporting pushed on all three. IEEE `ac:eb:e6:ff:fe:c8:29:60`,
> NWK `45790 (B2DE)`, **router** (mains-powered).

Exposed as **three Homey devices** from one node (`zigbee.devices`): channel A
(root), `channel2`, `relay`. Reason: Homey's `cumulative` energy flag is
per-device, and the two clamps need different cumulative settings (main incomer
vs sub-load). Each channel carries a `cumulative` checkbox → `setEnergy()`.

| field | value |
|-------|-------|
| `manufacturerName` | `Shelly` |
| `productId` (modelId) | `EM` |
| **ep1** | **relay / dry contact** — `onOff` (6), groups (4), scenes (5) |
| **ep2** | **CT clamp channel A** — metering (1794), electricalMeasurement (2820) |
| **ep3** | **CT clamp channel B** — metering (1794), electricalMeasurement (2820) |
| Metering `multiplier` / `divisor` | `1` / `1,000,000` (unusually large — see below) |

Matches the Zigbee2MQTT converter for this exact model, S4EM-002CXCEU
([PR #12245](https://github.com/Koenkk/zigbee-herdsman-converters/pull/12245)):
`onOff({endpointNames: ["1"]})`, `electricityMeter({endpointNames: ["2","3"]})`.

### The endpoint mapping cost hours — read this before touching it

For a long stretch the driver derived the layout from the node's own simple
descriptor, which at the time reported the **exact opposite**: metering on ep1,
`onOff` on ep3. Everything followed from that one wrong premise:

- channel B read ep1 (the *relay* endpoint) → `UNSUPPORTED_CLUSTER`, correctly,
  since there is no metering there;
- the relay was commanded on ep3 (a *metering* endpoint) → refused;
- **ep3, the real second CT channel, was never read once.**

This produced a completely wrong conclusion — "the Zigbee firmware only
implements one endpoint, the relay is dead, use Matter instead" — that was
argued confidently and was simply a driver bug. The device does all three jobs
over Zigbee.

The descriptor was not lying so much as **stale**: it was captured before the
device really settled into Zigbee mode, and a later dump showed the correct
layout (ep1 onOff, ep2+ep3 metering). It is nonetheless **hardcoded** in
`discoverEndpoints()` rather than derived, because a known-good mapping from a
working converter beats a descriptor that has already been wrong once.

Method lesson: `UNSUPPORTED_CLUSTER` is the device *refusing*; a timeout is the
device *not answering*. They are not the same evidence, and conflating them is
what made a driver bug look like a firmware limitation. Probe on a quiet radio,
serialised — parallel sub-device init drowns probes in meaningless timeouts.

### Other bugs found on the way

- **`meter_power` showed ~2.78 MWh for a real ~2.78 kWh reading.** Raw
  `currentSummationDelivered` 2,777,998 with `multiplier` 1 and `divisor`
  1,000,000. homey-zigbeedriver's default handling does not apply this device's
  (unusually large) divisor — a ~1000x inflation. Fixed by reading
  multiplier/divisor at init and scaling explicitly; see `fetchMeteringScale` /
  `registerMeterPower`.
- **`reportParser` receives the attribute VALUE, not an object.** Reading
  `report.currentSummationDelivered` off what is actually a number gave
  `undefined` → parser returned `null` → Homey treats `null` as "no update", so
  every report was silently discarded. This looked exactly like "the device
  accepts reporting then never sends any", and a polling workaround was added
  and later removed once the real cause was found.
- **Reporting must be configured explicitly.** `registerCapability` is
  synchronous and only records intent; the ConfigureReporting exchange happens
  later and can fail silently. `verifyReporting()` performs and awaits it so
  success/failure is visible.
- **The relay tile silently reverted on tap** because a failing command is
  reverted by Homey with no error surfaced. The driver now owns the `onoff`
  listener and logs the real reason.
### What to paste here after interviewing

```
Node: <node id>
manufacturerName: <...>
productId / modelId: <...>
Endpoint 1:
  input clusters:  <list>
  output clusters: <list>
Power source: <battery / mains>
```
