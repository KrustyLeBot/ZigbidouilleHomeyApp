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

---

## Devialet Phantom II 95 dB — stereo pair (driver `devialet`)

> **Status: interviewed 2026-08-01** via `probe/devialet/discover.js` (mDNS +
> local HTTP API). Firmware DOS 2.19.1, ipControlVersion 1.

Local REST API, no auth: `http://<ip>/ipcontrol/v1`. Discovered over mDNS as
`_devialet-http._tcp`, TXT carries `serialNumber`, `model` and `path`.

### The interviewed installation

| Role | Address | Serial | deviceId | Leader |
|---|---|---|---|---|
| `FrontLeft` | 192.168.1.22 | P44X01257P001 | `ad69fbcf-…` | **yes** |
| `FrontRight` | 192.168.1.11 | N51X01406P0LA | `bcbb1e72-…` | no |

Both belong to **one system**: `6bb4f39a-…`, `systemName` "Salon",
`systemType: "stereo"`.

### Why one Homey device per SYSTEM, not per speaker

`{systemId}` and `{groupId}` only accept the literal value `"current"`, which
resolves to the system of whichever speaker receives the request (the
"dispatcher"). So **talking to either speaker controls the whole pair**, and the
two speakers return identical system state.

The upstream app (`winnieoursbrun/homey-devialet`) creates one Homey device per
mDNS result, so a stereo pair yields two tiles fighting over one system. Here a
tile maps to a system and keeps **both addresses**, retrying the other when one
does not answer.

Caveat: *reading* a system setting works from any member, but *changing* one
requires the system leader to be reachable. The dispatcher forwards to it.

### Sources on this installation (7)

| Type | Host | Meaning |
|---|---|---|
| `bluetooth`, `airplay2`, `spotifyconnect`, `upnp`, `raat` | FrontLeft | non-physical, all hosted on one speaker |
| `opticaljack` | FrontLeft | the left speaker's own jack |
| `opticaljack` | FrontRight | the right speaker's own jack |

`sourceId`s are UUIDv4 and **not stable** — resolve them at runtime by matching
`type`, plus the host's `role` to tell the two jacks apart (the API docs say to
use `deviceId` for exactly this). Map `deviceId` → `role` from
`GET /systems/current` → `devices[]`.

Switch input with `POST /groups/current/sources/{sourceId}/playback/play`.

### Endpoints used

```
GET  /devices/current                                   deviceId, systemId, role, isSystemLeader
GET  /systems/current                                   systemName, systemType, devices[], availableFeatures
GET  /groups/current/sources                            [{sourceId, deviceId, type}]
GET  /groups/current/sources/current                    source, playingState, muteState, metadata
POST /groups/current/sources/{sourceId}/playback/play    switch input
POST /groups/current/sources/current/playback/{pause|next|previous|mute|unmute}
GET  /systems/current/sources/current/soundControl/volume    {volume} 0-100
POST /systems/current/sources/current/soundControl/volume    {volume}
POST /systems/current/sources/current/soundControl/{volumeUp|volumeDown}   5% steps
```

---

## Philips Hue Dimmer Switch v3 — RWL022 (driver `hue-dimmer-v3`)

> **Status: paired and confirmed 2026-08-01.** The Zigbee dump reports endpoint
> 1 with `manuSpecificPhilips` (64512) alongside the standard clusters, so the
> custom cluster below is registered and the fingerprint matches.

**Pairing:** hold the small setup button **on the back, next to the battery**
for ~10 s — *not* one of the four front buttons.

| field | value |
|-------|-------|
| `manufacturerName` | `Signify Netherlands B.V.` (also accepting `Philips`) |
| `productId` | `RWL022` |
| endpoint | `1` |
| clusters | `0` basic, `1` power, `3` identify, `4` groups, `6` onOff, `8` level, `4096` touchlink, `64512` **manuSpecificPhilips** |
| bindings | `1`, `6`, `8`, `64512` |

### The buttons do NOT come through standard clusters

The switch sends one manufacturer command, `hueNotification`, on Philips cluster
**0xFC00**, which `zigbee-clusters` does not ship — it is declared in
`app/lib/philips-hue-cluster.js`, with the frame layout taken from
[zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-herdsman-converters)
(`src/lib/philips.ts`, definition for RWL022).

```
hueNotification (command 0x00, server -> client)
  button   uint8    1 = top (I/Hue) · 2 = up · 3 = down · 4 = bottom (O)
  unknown1 uint24
  type     uint8    0 = press · 1 = hold · 2 = press_release · 3 = hold_release
  unknown2 uint8
  time     uint8    climbs while the button is held
  unknown3 uint8
```

Receiving it needs a **BoundCluster** bound to the endpoint — a listener is not
enough for an incoming command.

### The magic write

`configure()` in the Z2M converter writes `genBasic` attribute `0x0031` = `0x000B`
with manufacturer code Signify (`0x100B`). Without it the switch keeps sending
plain on/off and level commands and never emits `hueNotification` — the likely
reason other apps handle this remote poorly.

Here the attribute is declared on the Philips cluster itself (Z2M's own cluster
definition also places `config` at `0x0031`) and written best-effort: patching
the shared `basic` cluster globally would affect every other device in the app,
and some firmwares are already in the right mode.

### `hold` repeats — that is the point

While a button is held the switch re-sends `hold` roughly every 0.8 s. Each
repeat fires the flow again, which is what makes "hold to ramp the volume"
work at all.
