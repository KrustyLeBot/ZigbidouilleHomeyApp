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
- **Negative power (export) was thrown away.** homey-zigbeedriver's default
  `measure_power` parser for Electrical Measurement does `if (value < 0) return
  null;`, and `null` means "no update" — so on a clamp fitted to the main
  incomer, every reading taken while production exceeded consumption was
  dropped and the tile froze on the last positive value. `activePower` is an
  `int16` precisely so it can be negative. The driver now supplies its own
  parser (`registerMeasurePower`) that keeps the sign.

### Export energy (kWh) — `currentSummationReceived`, confirmed present

`meter_power` reads **`currentSummationDelivered`**, which only ever climbs on
import. Export accumulates in **`currentSummationReceived`** (also `uint48`,
**optional** in the ZCL spec), surfaced as the sub-capability
`meter_power.exported`.

**Confirmed on this unit 2026-08-02**: ep2 answered the read (`raw=0`), accepted
ConfigureReporting, and pushed an unsolicited report a minute later — so the
firmware does implement it. Still probed rather than assumed, because the
attribute is optional and other firmware revisions may not have it: the capability
is added when the read answers and removed on `UNSUPPORTED_ATTRIBUTE`. A timeout
changes nothing and re-probes next restart.

The probe uses its **own** read, not appended to the multiplier/divisor one: an
unsupported attribute can fail a whole multi-attribute request, which would cost
the import reading too.

`applyCumulative()` sets `cumulativeExportedCapability` alongside
`cumulativeImportedCapability`. Without it Homey cannot tell the two
`meter_power.*` registers apart and reads production as consumption.

Still unverified: negative `measure_power` end to end — the unit has only ever
been observed importing.
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

## Xiaomi Robot Vacuum 5 — `xiaomi.vacuum.ov31gl` (driver `vacuum5`)

> **Status: swept live 2026-08-02**, firmware `1.2.20`, model `OV31GL`.
> Not Zigbee — miIO over UDP, credentials in the repo-root `.env` under
> `VACUUM5_`. Interviewed with [`probe/vacuum5`](../probe/vacuum5).

**It shares no field numbering with the X20+.** Its service 4 is the *alarm*,
so there is no `4/7`; every field had to be found again. 164 readable
properties, against ~30 on the `c102gl`.

### The published spec is wrong again

[home.miot-spec.com](https://home.miot-spec.com/spec/xiaomi.vacuum.ov31gl) gives
the status enum as `1` Standby · `2` Charging · `4` Working · `5` Paused ·
`6` Returning · `15` Error · `16` Sweeping+Mopping. The robot reports **`14`
while docked** and **`1` while cleaning**, and never reported `16` through an
entire vacuum+mop run. Same lesson as the `d109gl` spec on the X20+: sweep, do
not read.

The spec also labels `2/3` as `fault`. It is not.

### Field map

| field | meaning |
|-------|---------|
| **`2/2`** | **status** — `1` standby off-dock (counters frozen) · `2` on the dock · `4` **cleaning** · `5` paused · `6` returning at the end of the job · `7` at the station (mop prep, or mid-clean rinse) · `9` washing the mop · `14` on the dock · **`20` driving home MID-CLEAN to rinse the mop** |
| **`2/3`** | **pending task** — `100008` none · `100028` a job is under way |
| **`2/6`** | **cleaned area, in hundredths of m²** (`5700` = 57 m²) — resets at job start |
| `2/7` | cleaning time in **seconds** — resets at job start |
| `2/11` | mop fitted |
| `2/18` | station, as a JSON **string** `{"mode":n}` — `3` preparing, `1` idle at the dock, `0` while the robot is away |
| `2/66` | **fault**, as a JSON string `{"ts":…,"fault":[0]}` |
| `2/90` | minutes left on the drying cycle |
| `3/1` · `3/2` | battery · charging (`1` on dock, `2` off dock) |

`2/16` carries the room list, `10/3` the cleaning history, `10/5` the maps —
richer than anything the `c102gl` exposes, and unused so far.

### `2/3` is the `4/7` equivalent — the field the driver depends on

Observed `100008` with the robot idle, and `100028` from the instant a job was
launched, **held unchanged** across station prep, leaving the dock, cleaning, a
manual pause, the drive home and the mop wash on the dock.

That is what makes "docked" separable from "done": at 22:24:24 the robot
reported `status 14` (docked) with `2/3` still `100028`, which is exactly the
case that once fired `task_completed` mid-job on the X20+ and froze the area at
16 m² of a 28 m² run.

**Confirmed end to end on 2026-08-08**, over a full 57 m² vacuum+mop run:
`100028` was set at 07:00:04 and cleared at 08:28:05. Crucially it clears
**while the robot is still driving home** — a minute and a half before it
reaches the dock — so the completion fires on arrival, not on the drop.

Replaying that recorded run through the profile produces exactly one
completion, at 08:29:25, with the full 57 m². The five mid-clean mop rinses
pass through without ever concluding.

### The five states a single run passes through

```
7  station      mop prepared before setting off
4  cleaning     area and time climb here, and ONLY here
20 returning_wash   home mid-clean to rinse the mop      \  five times
7  station          rinsing at the dock                  /   in one run
6  returning    end of job — the task ALREADY reads 100008
2  docked       arrival: this is where completion fires
```

Two readings had to be corrected against this log. Status `4` was taken for
"active but not yet cleaning" and is the cleaning state itself; status `1` was
taken for cleaning and is standby with frozen counters. And `20` was simply
unknown — read as the end of the job it would have cut the run short at 10 m²
of 57.

### Two client bugs this model exposed

- **The robot overwrites the `did` in its reply** with its own numeric device id
  (`1172803803`), identically on every entry. `getProperties` keyed its result
  by `entry.did`, so the whole reply collapsed onto one key and every field read
  `undefined` — with no error. It now keys by request order, cross-checked
  against the entry's `siid`/`piid`. The X20+ echoes the did back, which is why
  this went unnoticed.
- **Structured fields arrive as JSON strings**, not objects (`2/18`, `2/66`).
  Treating `2/66` as an object made every fault read as 0.

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
