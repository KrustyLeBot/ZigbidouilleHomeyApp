# Zigbidouille — Homey app for devices nobody else supports

A Homey app for **devices that don't have a dedicated Homey app** — the cheap
sensors, plugs and switches that pair as a nameless "generic Zigbee device" (or
refuse to pair at all), and the appliances whose vendor app collapses everything
useful into a handful of standard values.

Zigbidouille is that missing driver, per device. Each unsupported model gets a
small driver that maps whatever it speaks onto proper Homey capabilities, flow
cards and Insights — the same first-class experience a supported device gets.

**Protocol-agnostic by design.** Homey declares connectivity *per driver*, so a
single app can host several at once. Today: **Zigbee** (via the Homey radio),
**LAN** (miIO over UDP for the vacuums, local HTTP for the Devialet) and
**cloud** (the Imou cameras and the Somfy alarm, where no local protocol reaches
the settings that matter). Matter or anything else can join later without
restructuring anything — only the device layer differs, and the shared plumbing
(logging, debugging, settings) is protocol-neutral.

Everything runs **locally where the device allows it** — no bridge, no vendor
hub. The Imou cameras and the Somfy alarm are the exceptions, marked as such
below, and only because what they expose exists nowhere but the vendor's cloud.

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
  and clusters, the vacuums' **raw miIO trace**, the cloud credentials for Imou
  and Somfy (each with a *Test* button), and a **verbose logging** switch that
  applies to all protocols at once.

## Supported devices

| Device | Driver | Protocol |
|---|---|---|
| Heiman HS-720ES — CO detector | `co-hs720es` | Zigbee |
| Shelly EM Gen4 — 2-channel energy meter + dry contact | `shelly-em-gen4` | Zigbee |
| Philips Hue Dimmer Switch v3 (RWL022) | `hue-dimmer-v3` | Zigbee |
| Xiaomi Robot Vacuum X20+ (`c102gl`) | `x20plus` | LAN (miIO) |
| Xiaomi Robot Vacuum 5 (`ov31gl`) | `vacuum5` | LAN (miIO) |
| Devialet Phantom (single or stereo system) | `devialet` | LAN (HTTP) |
| Imou Ranger 2C | `imou-ranger2c` | cloud |
| Imou Cell PT | `imou-cellpt` | cloud |
| Somfy Protect alarm | `somfy-alarm` | cloud |
| kWh meter (virtual) — tracks any other device's `measure_power` | `kwh-meter` | LAN (Homey's own local API) |

The Zigbee identity, MIoT field map or API surface of every one of them is
written down in [docs/fingerprints.md](docs/fingerprints.md) — including the
readings that turned out to be wrong, so nobody re-derives them.

### Heiman HS-720ES — carbon monoxide detector (`co-hs720es`) · Zigbee

Battery detector using the standard IAS Zone alarm pattern: `alarm_co`,
`alarm_battery`, `measure_battery`. CO alarms arrive as a push notification the
moment the detector fires. A good template for any Zigbee alarm sensor.

### Shelly EM Gen4 — 2-channel energy meter + dry contact (`shelly-em-gen4`) · Zigbee

One physical device exposed as **three Homey devices** from a single pairing:

| Tile | What it does |
|---|---|
| Channel A | CT clamp 1 — live power (W), imported and exported energy (kWh) |
| Channel B | CT clamp 2 — live power (W), imported and exported energy (kWh) |
| Dry contact | On/off control of an external load (e.g. a contactor) |

Each channel has a **"Whole-home meter (cumulative)"** setting. Tick it on the
clamp sitting on the main incomer: Homey then treats that channel as the house
total and subtracts every other metered device from it, showing the remainder as
"other". Leave it off for a sub-load such as heating.

**Solar production is handled**: `measure_power` keeps its sign, so a clamp on
the incomer reads negative while production exceeds consumption, and exported
energy accumulates separately in `meter_power.exported`. That export register is
optional in the Zigbee spec, so the driver probes for it at init and only adds
the capability when the meter actually answers.

The split into three devices is deliberate — Homey's `cumulative` flag is
per-device, so two clamps needing different cumulative settings cannot share
one.

**Dashboard widget** — "Shelly energy (today)"
(`app/widgets/shelly-energy`) shows **one figure**: the energy imported since
local midnight, in kWh. Pick which channel it shows in the widget's own
settings; add it twice to watch both.

It used to draw a per-minute bar chart of the day. That is gone, along with the
1440-slot recorder that fed it — the number is what was wanted, and keeping a
sample per minute per channel in the device store to draw it was the tail
wagging the dog.

Today's kWh is a **delta against the meter's own cumulative total**, never a sum
this app accumulates: an accumulator drifts, and it restarts at zero on every
reinstall. So the only thing [app/lib/energy-today.js](app/lib/energy-today.js)
has to know is the meter reading as it stood at 00:00, and it gets that from
three places, in order:

1. **The device store**, if the saved reading is from today — this is what
   survives an app restart or a CLI reinstall, and it is the usual case.
2. **Homey's Insights**, through the Web API — the only way to learn the 00:00
   reading of a day that is already underway (a fresh pair, or a store that was
   wiped). This is what stops the widget from reading `0.00` for the rest of the
   day after a mid-afternoon reinstall.
3. **The meter right now** — wrong, but wrong in the obvious direction: the
   figure starts at 0 and climbs. The widget labels itself *since install* while
   this is the case, rather than passing a partial total off as the day's, and it
   keeps asking Insights every 10 minutes until one of them answers.

**A cold start is not midnight.** Both leave "the stored day is not today", and
treating them alike is what made the widget read ~0.00 after a reinstall: the
baseline was marked a *certain* 00:00 reading, so the Insights lookup was skipped
and never even logged. Crossing midnight while running means the meter right now
IS the 00:00 value; starting with an empty store means it is a guess. Only the
previous day being known separates the two.

The app's own `homey.insights` is *not* the way in: its `getLog(id)` takes a
lowercase-alphanumeric id and only returns logs the app itself created. A
device capability's log belongs to Homey core and is reachable only through
the Web API — which is why this app carries **`homey:manager:api`**. That
permission reads as "full access to Homey" at install time, and it also means
a longer review if the app is ever published.

That one permission is *all* it needs, including for Insights: `homey:manager:api`
is what lets the app call `homey.api.getOwnerApiToken()`, and the owner token
carries every scope, `homey.insights.readonly` among them. Nothing extra is
declared or prompted for — and a CLI-installed app is never prompted at all,
since the permission dialog belongs to the App Store install flow.

**The spec and the firmware disagree about the log id.** The shipped `homey-api`
spec says a log's `id` is a plain UUID with the device in `ownerUri`. Read on a
real Homey Pro (firmware 12.x), the ids are `homey:device:<uuid>:<capability>`
and `ownerId` holds the bare capability id. So the id is **resolved** from
`insights.getLogs()` and matched — by capability id first, then by unit — rather
than trusting either shape. The one line of log this prints is the only reliable
statement of what a given firmware returns:

```
insights — logs for device <uuid>:
  homey:device:<uuid>:energy_power         ownerId=energy_power         units=W
  homey:device:<uuid>:meter_power          ownerId=meter_power          units=kWh
  homey:device:<uuid>:meter_power.exported ownerId=meter_power.exported units=kWh
```

That listing also settled what the original failure actually was, which was *not*
the id format: the code asked for `measure_power`, and a Shelly channel has no
such log — only `energy_power` for the watts. **"Not Found" means "no such log",
not "wrong id"**, and reading it as the latter cost a detour.

Because nothing on a log is *documented* to carry the capability id, the match
falls back to the log's **unit** when no field names it: a metering channel has
one `W` log and two `kWh` ones, so "kWh, and not the export register" singles out
`meter_power`. An empty answer does not end the search either — that is exactly
what the wrong log returns.

**The stored baseline is versioned.** Not hygiene: a same-day record is by design
never re-derived, so the one build that saved a mid-day baseline as *certain*
would have kept showing its wrong figure through every reinstall until midnight —
looking exactly like the bug it came from. Anything that changes what a stored
field means bumps `STORE_VERSION`, and older records are dropped with a log line.

[probe/homey/insights.js](probe/homey/insights.js) dumps the real log ids from
outside the app, which is how the id shape was settled.

Every device id involved goes through
[app/lib/device-uuid.js](app/lib/device-uuid.js), which **discovers** Homey's
device UUID on the instance rather than reading a documented property — the
Apps SDK does not expose one, and assuming `device.id` silently yielded
`undefined` (see the comment there before reaching for it again).

Widgets require Homey firmware **>=12.3.0** (12.1.0 for widgets themselves,
12.3.0 for the device picker), which is now the app's `compatibility` floor.

### Philips Hue Dimmer Switch v3 — RWL022 (`hue-dimmer-v3`) · Zigbee

The four buttons, usable in flows without a Hue Bridge: one **"A button was
pressed"** trigger taking the button (top / brightness up / brightness down /
bottom) and the action (pressed, held, released, hold released), plus
`measure_battery`.

The buttons do not arrive on the standard on/off and level clusters — the switch
sends a single manufacturer-specific `hueNotification` command on Philips
cluster `0xFC00`, and only after a magic attribute write at init tells it to.
That cluster is not in `zigbee-clusters`; it is declared in
[app/lib/philips-hue-cluster.js](app/lib/philips-hue-cluster.js). This is the
likely reason other apps handle this remote poorly.

**Held repeats** roughly every 0.8 s while the button stays down, and each
repeat fires the flow again — which is exactly what makes "hold to ramp the
volume" work.

Pairing: hold the small setup button **on the back, next to the battery** for
~10 s — not one of the four front buttons.

### Xiaomi Robot Vacuum X20+ (`x20plus`) and Robot Vacuum 5 (`vacuum5`) · LAN (miIO)

Two drivers, one for each robot (`xiaomi.vacuum.c102gl` and
`xiaomi.vacuum.ov31gl`). They share no field numbering whatsoever — the same
information sits at different MIoT properties, with different enums and
different units — so each was interviewed separately and gets its own driver
and its own map. They do share the client, the CSV recorder and the state
machine shape.

Both talk to the robot **locally over the miIO protocol** (UDP, AES-128) — no
cloud. They exist because the general-purpose Xiaomi app collapses the robot's
real states into Homey's five standard vacuum values, throwing away the one
distinction that matters: **was it interrupted while cleaning, or on its way
back to the dock?** Those need different handling, and resuming the wrong one
starts a full clean of the whole home.

- A dedicated `Status` capability with the robot's real states, including the
  two the standard app merges.
- **Two separate resume actions** — *Resume cleaning* and *Resume return to
  dock*. Deliberately separate: the app never guesses which one you meant.
- Flow triggers for every stuck state, each confirmed after 90 s so a robot that
  frees itself does not notify.
- Cleaned area per run in Insights, and a raw miIO CSV export in the settings.

Each robot needs a fixed local IP and its 32-character miIO token, entered
during pairing — see [INSTALL.md](INSTALL.md).

Every value in both drivers was reverse-engineered by probing a real robot: the
published spec is for a different variant on the X20+, and simply wrong on the
Vacuum 5 (which reports `14` while docked and `1` while cleaning, against a spec
that says neither). See [FINDINGS.md](FINDINGS.md) and
[docs/fingerprints.md](docs/fingerprints.md), and `probe/` for the scripts that
produced them — including `sweep.js`, which brute-forces the property space and
diffs two robot states to identify unknown fields.

### Devialet Phantom (`devialet`) · LAN (HTTP)

Transport, volume, mute, source switching and the current track, over the
speakers' **local REST API** — no account, no Devialet cloud.

**One Homey tile per system, not per speaker.** A stereo pair is a single
system: either speaker answers for both, and they report identical state. Apps
that create a device per discovered speaker end up with two tiles fighting over
one system. Here a tile holds every member address and retries the other when
one does not answer.

Sources are resolved at runtime rather than stored — their ids are UUIDs that
are **not stable across restarts** — so the flow card offers them by type
(Bluetooth, AirPlay 2, Spotify Connect, UPnP, RAAT, optical jack), with the two
speakers' jacks told apart by their role.

### Imou Ranger 2C and Cell PT (`imou-ranger2c`, `imou-cellpt`) · cloud

**Privacy mode** (the lens shutter) and, on the Cell PT, the **motion detection**
switch and battery level — as capabilities and flow cards, so the alarm being
armed can close the shutters and disarming can open them.

These are the app's **only cloud devices, and a deliberate exception**: these
switches exist nowhere but the Imou Open Platform. ONVIF and the local protocols
reach the video stream and motion events, never these settings. Needs an app id
and secret from the [Imou Open Platform](https://open.imoulife.com/), entered in
**Settings → Imou**; cameras already paired in the Imou Life phone app are shared
to the developer account automatically, and the phone app keeps working.

The free account allows **30,000 API calls per month for the whole account** —
not the 20,000/day several secondary sources claim. Hence the 20-minute default
poll, the batched online check shared between cameras, and the battery read
happening every 6th cycle: together that is roughly **770 calls a day** for five
cameras, about 23,000 a month. Lowering `poll_interval` multiplies call volume
directly — at 5 minutes the same five cameras spend the entire monthly quota in
ten days.

### Somfy Protect alarm (`somfy-alarm`) · cloud

Reports the alarm's state (`disarmed` / `partially_armed` / `armed`) and whether
it is currently triggered, with flow triggers on every change — so arming the
house can close the camera shutters, and a trespass event can drive anything
Homey can reach. It can also **arm, disarm and switch night mode**, straight
from the device tile's alarm-panel widget (a one-tap button, works well on a
dashboard) or from a `somfy_set_state` flow action card.

It talks to the same backend the phone app does, through an unofficial API
reverse-engineered by the community — worth knowing, since that is not
something to put in charge of a physical security system without understanding
what it rides on.

Use a **secondary account with the Guest role**, created for this purpose, in
**Settings → Somfy** — never the login that guards your front door. Guest is
enough for everything this driver does, including arming and disarming (Somfy
intends it to: guests need to switch the alarm off when they come in). What it
cannot do is remove devices, change the site configuration or manage users,
which is the real reason to prefer it over an "owner" secondary account.

State arrives over Somfy's own **websocket** in about a second; the 15-minute
poll is a resync safety net for a dropped message, not the mechanism. A write
from Homey updates the tile optimistically and is normally confirmed by the
same websocket a second or two later.

**Dashboard widget** — "Somfy alarm" (`app/widgets/somfy-alarm`) is the phone
app's dial, on a Homey dashboard: a ring cut into three wedges — **away** at the
top, **night** to the right, **off** to the left. The current state is the one
filled in, with its name in the middle of the ring; tap either of the other two
to switch. The tapped wedge pulses until the app confirms, and nothing else is
tappable while a write is in flight — a second tap would race the first.

While the siren is ringing, `ALARM RINGING` appears under the state name in the
armed colour. Pick which alarm the widget drives in its own settings, the same
way as the Shelly one.

Both the read and the write go through the device, so the Guest-role account,
the optimistic update and the error logging are the ones described above — the
widget adds no path of its own to the alarm.

### Electrical panel widget (`app/widgets/tableau-electrique`)

Not tied to any driver or device — a static reference tool for one specific
breaker panel, reconstructed from a spreadsheet and close-up photos. No
backend: the wiring never changes on its own, so the full breaker→loads map
and the room→appliance reverse index are embedded straight in
`public/index.html` rather than fetched, and there is no `api.js`. Read-only —
tapping a breaker only highlights it and shows what it feeds; there is no
on/off simulation, since the widget never actually knows whether a breaker is
physically cut.

Two ways in: tap a breaker in the panel to see what it feeds, or use the
search box below it to find which breaker to flip for a given appliance
("frigo", "radiateur SDB", "box"…) — tapping a result highlights the matching
breaker up in the panel too. The search matches both the appliance's own name
and the breaker's "what it feeds" text, so a colloquial term like "frigo"
still finds "Réfrigérateur" (which is on the same circuit as the actual word
"frigo", in disjoncteur 8's description) even though it is not a literal
substring of the appliance's own label.

A trimmed-down version of a larger standalone page (kept outside this repo):
the full page also has a to-fix/to-verify list, left out here to keep the
widget to what it is for — finding the right breaker, nothing else. Width is
kept fully responsive (breaker rows and the appliance grid both wrap rather
than scroll sideways, checked at phone and tablet widths); height is not
constrained the same way, so the panel and the full reverse search both stay
permanently expanded — see the height comment in `public/index.html` for why
that specifically matters here.

### kWh meter (virtual) (`kwh-meter`) · LAN (Homey's own local API)

Not a physical device — this driver pairs a *virtual* meter to any other
device on the same Homey that exposes `measure_power`, and turns its
instantaneous watts into a real, monotonic `meter_power` (kWh) that Homey
Energy, its top-consumers list and Insights can all derive day/week/month/year
figures from. Built for one specific problem: a device whose own `meter_power`
is missing, or present but wrong (a Sonoff Zigbee plug whose kWh count does
not track reality), still gets first-class Energy support this way, without
touching the source device's own driver.

**Pairing is a multi-select.** It lists every device on the Homey with a
`measure_power` capability (excluding Zigbidouille's own devices, to avoid a
meter tracking a meter) and creates one virtual device per selection, each
keeping the exact same name as its source (renameable afterwards, like any
Homey device — nothing here re-applies the name later). The link to its
source (`store.sourceId`) is fixed at pairing time — re-pairing does not
offer a device that already has a meter tracking it. It lands in Homey's
default zone like any newly paired device; moving it to the room its source
is actually in (or to a shared "Energy" zone) is a manual drag, same as any
other device.

**Integration is zero-order hold, sampled continuously.** Between two
`measure_power` readings, the source is assumed to have drawn the *older* of
the two the whole time; a periodic 30 s timer closes an interval even when
nothing changed, since `measure_power` only pushes on a real change and a
constant load (a pool pump, say) would otherwise stop being counted the
moment it stops changing. A long gap — an app restart, a Homey reboot, a
phone that slept through some ticks — is capped at 10 minutes of assumed
draw rather than integrated across its full length, so waking up does not
fabricate an energy spike.

**Never resets, never goes backwards.** The cumulative total only ever gets a
non-negative amount added to it — structurally, not by an after-the-fact
check — because Homey Energy reads any drop in a `meter_power` as negative
consumption and corrupts its own derived figures. A reboot reloads the exact
kWh total last persisted and restarts the clock at "now" (the downtime's power
draw is unknown, so it is skipped rather than guessed); a fresh pairing starts
at 0.

**If the source goes offline**, the meter keeps integrating at the last known
wattage for 10 minutes (a short Wi-Fi drop probably means the load is still
running), then assumes 0 until the source is heard from again. **If the source
is deleted**, the virtual device goes unavailable and its total freezes —
never reset — until it is removed by hand.

**You still have to tell Homey to stop double-counting the source.** This
driver reads the source's `measure_power`, but does nothing to the source's
own `meter_power` if it has one — so a Sonoff plug with a broken kWh count
would otherwise be counted twice in Energy (once by itself, once by its
virtual meter). Turn on **"Exclude from Energy"** on the source device itself,
in the Homey app's own device settings. That only removes the source's own
(wrong) kWh contribution; its live W still shows in Energy, because the
virtual meter mirrors it into its own `measure_power`.

Two assumptions in [lib/kwh-meter-device.js](app/lib/kwh-meter-device.js) are
not yet confirmed against a real offline/deleted source — see the comments
there and [docs/fingerprints.md](docs/fingerprints.md).

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
which is why the Xiaomi vacuums live here too, speaking miIO over the LAN, and
why the Devialet gets a tile per system instead of per speaker.

And sometimes the control simply does not exist locally. The Imou privacy
shutter and the Somfy alarm state have no local protocol at all, so those two
drivers go through the vendor cloud — stated plainly rather than pretended
away.

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

- Homey Pro (SDK 3, local platform, firmware **>=12.3.0** — required for the
  dashboard widget's device picker, and applies to the whole app since
  `compatibility` is set app-wide); a built-in Zigbee radio for the Zigbee
  drivers.
- Zigbee devices physically in range during pairing; LAN devices reachable on
  the network (each vacuum also needs a fixed IP and its miIO token).
- For the cloud drivers, credentials entered in the app settings before pairing:
  an Imou Open Platform app id/secret for the cameras, and a Somfy Protect
  account for the alarm (a Guest-role secondary one, see above).
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

The vacuums ask for their IP and miIO token during pairing. The Imou and Somfy
drivers instead read shared credentials from the app settings, so fill in
**Settings → Imou** / **Settings → Somfy** (each has a *Test* button) *before*
pairing — their pairing screen lists the devices found on the account.

## Project layout

```
app/                       the Homey app
  app.js                   registers the flow cards of every non-Zigbee driver
  app.json                 manifest: capabilities, drivers (per-driver connectivity), flow
  lib/
    errlog.js              rolling log shared by every driver, persisted, verbose-aware
    zigbee-device.js       Zigbee base class (capability migration, node dump, logging)
    energy-today.js        today's imported kWh + Insights 00:00 baseline (widget)
    device-uuid.js         discovers Homey's device UUID — the SDK exposes none
    philips-hue-cluster.js Philips 0xFC00 cluster — not shipped by zigbee-clusters
    miio-client.js         miIO client: UDP handshake + AES-128 (both vacuums)
    miio-vacuum-device.js  shared vacuum device: poll loop, state machine, triggers
    x20plus.js             the X20+ MIoT map and status profile
    vacuum5.js             the Vacuum 5 MIoT map — shares nothing with the X20+
    recorder.js            raw miIO CSV recorder (X20+)
    recorder-vacuum5.js    raw miIO CSV recorder (Vacuum 5)
    devialet-client.js     local HTTP client, retried across the system's speakers
    devialet-sources.js    source types -> runtime source ids
    imou-client.js         Imou Open Platform HTTPS client (signing, tokens)
    imou-account.js        shared credentials + batched online-status cache
    imou-camera-device.js  shared camera device: poll budget, switches, battery
    imou-ranger2c.js       Ranger 2C profile (switches it actually supports)
    imou-cellpt.js         Cell PT profile (adds motion detection + battery)
    somfy-client.js        unofficial Somfy Protect HTTPS client (OAuth, GET /v3/site)
    somfy-account.js       shared credentials + persisted token
    somfy-events.js        the Somfy websocket: live events, ping, backoff
    somfy-alarm-device.js  the alarm device — reports state and can arm/disarm/night-mode it
    kwh-meter-account.js   shared HomeyAPI instance + device-deleted fan-out
    kwh-meter-device.js    the virtual meter — ZOH integration, monotonic meter_power
  drivers/
    co-hs720es/            Heiman HS-720ES CO detector          — zigbee
    shelly-em-gen4/        Shelly EM Gen4, 3 sub-devices        — zigbee
    hue-dimmer-v3/         Philips Hue Dimmer Switch v3         — zigbee
    x20plus/               Xiaomi X20+ vacuum                   — lan (miIO)
    vacuum5/               Xiaomi Robot Vacuum 5                — lan (miIO)
    devialet/              Devialet Phantom, one tile per system — lan (HTTP)
    imou-ranger2c/         Imou Ranger 2C                       — cloud
    imou-cellpt/           Imou Cell PT                         — cloud
    somfy-alarm/           Somfy Protect alarm                  — cloud
    kwh-meter/             virtual kWh meter, tracks another device's measure_power — lan (Homey's own local API)
  locales/                 en.json / fr.json
  settings/                5 tabs: log · Zigbee dump · raw miIO log · Imou · Somfy
  widgets/
    shelly-energy/         dashboard widget — today's imported kWh, one figure
    somfy-alarm/           dashboard widget — 3-wedge alarm dial, tap to arm/disarm
    tableau-electrique/    dashboard widget — breaker panel, tap to see what it feeds (no device, no backend)
probe/                     standalone scripts — talk to a device without Homey
  env.js                   shared .env loader: PREFIX_IP / PREFIX_TOKEN, never printed
  x20plus/ vacuum5/        miIO tooling: watch live, scan properties, list actions
    sweep.js               brute-force siid/piid discovery, and diff two robot states
  devialet/discover.js     mDNS + local HTTP interview
  imou/                    probe the cloud API; sweep.js diffs all 49 camera switches
  somfy/                   probe the REST API; listen.js dumps the live event socket
  homey/insights.js        Homey's own Insights logs: real ids, and do they fetch?
docs/fingerprints.md       every device interviewed: identity, field maps, wrong readings
docs/Homey Notification.mp3  notification sound, for use in Flows (not used by the app)
FINDINGS.md                everything learned by probing the real vacuum
CLAUDE.md                  conventions + the device-adoption workflow + hard rules
INSTALL.md                 install steps and CLI/Node gotchas
.env                       device IPs, miIO tokens, cloud secrets — gitignored, never commit
.env.example               the template to copy, with what each credential is for
```

## Credits

- Zigbee SDK: [athombv/node-homey-zigbeedriver](https://github.com/athombv/node-homey-zigbeedriver)
  and [athombv/node-zigbee-clusters](https://github.com/athombv/node-zigbee-clusters).
- [Zigbee2MQTT](https://www.zigbee2mqtt.io/supported-devices/) and its
  [converters](https://github.com/Koenkk/zigbee-herdsman-converters) — the best
  cross-reference for what a given model actually speaks. The Shelly EM Gen4
  endpoint map here comes from
  [PR #12245](https://github.com/Koenkk/zigbee-herdsman-converters/pull/12245).
  The Hue Dimmer v3's `hueNotification` frame layout and the magic init write
  come from the same repo (`src/lib/philips.ts`, definition for RWL022).
- [ZHA device handlers](https://github.com/zigpy/zha-device-handlers) — same
  role on the Home Assistant side, useful when a device has no Z2M converter
  yet.
- miIO protocol reference: [rytilahti/python-miio](https://github.com/rytilahti/python-miio),
  cross-checked against [shaarkys/com.xiaomi-miio](https://github.com/shaarkys/com.xiaomi-miio).
  Token extraction: [PiotrMachowski/Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor).
- Imou Open Platform: the official [API docs](https://open.imoulife.com/), with
  [user2684/imou_life](https://github.com/user2684/imou_life) as the reference
  Home Assistant integration — including for what the API *cannot* do.
- Somfy Protect (unofficial, reverse-engineered by the community):
  [Minims/somfy-protect-api](https://github.com/Minims/somfy-protect-api),
  [Minims/SomfyProtect2MQTT](https://github.com/Minims/SomfyProtect2MQTT) (whose
  websocket timings this app reuses) and
  [jay-d-tyler/homebridge-somfy-protect](https://github.com/jay-d-tyler/homebridge-somfy-protect).
- Devialet: the speakers' own local `ipcontrol/v1` API, with
  [winnieoursbrun/homey-devialet](https://github.com/winnieoursbrun/homey-devialet)
  as prior art (this app differs by mapping a tile to a *system*, not a speaker).
