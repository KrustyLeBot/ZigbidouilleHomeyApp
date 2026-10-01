# CarHooks — Android Auto companion

Two big tiles in the car — **DÉPART** and **ARRIVÉE** — that each fire a Homey
webhook. One tap leaving the house, one tap arriving. The same two buttons exist
on the phone, and the webhook URLs are configured there.

The action labels stay French, like every other display string in this repo:
internal identifiers are English (`depart`, `arrivee`), only what you read on
screen is translated.

It is not a Homey driver and it ships nothing to Homey. It is an Android app that
lives in this repo because it is useless without the Flows on the other end.

## Why it exists

Android Auto (phone projection) only admits **categories of app Google has
approved**: navigation, media, messaging, charging/POI. There is no "generic
button that calls a URL" category, and no such app passes review — so neither
Homey nor MacroDroid has an Android Auto surface.

The workaround is to **present as a media app**. Android Auto renders a media
app's browse tree as a grid of tiles, and tapping a tile is a well-defined
callback. So the tree holds two "tracks" that are really actions, and the tap
fires the webhook instead of starting playback.

What was considered and rejected:

- **Voice.** "Hey Google" works in the car, and a Homey Virtual Device exposed to
  Google Home can be triggered that way. But the Assistant regularly fails to
  reach third-party devices in the car while the same phrase works on the phone.
  Fine as a fallback, too flaky as the primary path.
- **Automation instead of a button** — an "Android Auto connected" or geofence
  trigger calling the webhook with no interaction at all. Genuinely more
  reliable, and worth having *as well*. But it fires on its own schedule, not
  when you decide.
- **A BLE button on the steering wheel** (a Flic 2 calling the webhook from its
  own Internet Requests action). Works, costs €35, and depends on the Flic app
  surviving Android's battery optimisation. No screen, no feedback.

This app is the on-screen path: deliberate, visible, with the HTTP result shown
back to you.

## What it looks like

**On the phone** — two buttons filling the screen, a gear icon top right, and a
status line showing the last result. The phone UI is also the test surface: it
calls exactly the same code path as the car, so you debug URLs and Flows at your
desk and never in the driveway.

**In the car** — the app appears in Android Auto's media section as a grid of two
tiles. The tile subtitle carries the last result (`14:32:07 — OK (200)`), so you
can glance at what happened on the previous trip.

## The Homey side

Homey has no built-in "Flow triggered by a URL" card. You get one from a
community app — the Webhooks app, or any of the HTTP-request Flow-card apps —
which hands you a URL per Flow. That URL is what goes in the app's settings.

Two patterns work. **Use one URL per action**, not a single URL with an
`?action=depart` parameter: when something breaks you want to know whether the
request never arrived or arrived and the Flow did nothing, and separate URLs
answer that from the HTTP status alone.

```
DÉPART   https://<webhook-host>/<id of the départ Flow>
ARRIVÉE  https://<webhook-host>/<id of the arrivée Flow>
```

GET is the default and is enough for a trigger. POST with a JSON body is there
for Flows that read values out of the request.

**HTTPS only.** The app does not declare `usesCleartextTraffic`, so Android
refuses plain `http://`. A cloud webhook with a valid certificate is fine. A
local Homey Pro URL with a self-signed certificate will fail the TLS handshake —
in that case either add `android:usesCleartextTraffic="true"` to `<application>`
and use `http://`, or pin the certificate.

Settings live in SharedPreferences and are read fresh on every tap, so editing a
URL on the phone takes effect in the car immediately — no restart, no re-pair.
Nothing is hardcoded in the source: the repo carries no URL, no Flow id, no
token.

## Hard rules — never cut the music

The whole point is to tap a tile while Spotify keeps playing. Spotify is
interrupted by **audio focus**, nothing else. Three rules keep it playing, and
all three are load-bearing:

1. **Never call `requestAudioFocus()`.** The app plays nothing, so it has no
   reason to ask. This is the entire difference from the silent-playlist hack,
   where a real player requested focus and paused Spotify.
2. **Never reach `STATE_PLAYING`.** The most recently active session owns media
   key routing — including the steering wheel buttons. Going to `STATE_PLAYING`
   would steal them, which would be a rich irony for a project that started from
   wanting a steering-wheel shortcut.
3. **No `MediaStyle` notification, no foreground service.** The app must not
   appear in the stack of players at all.

The session does have to be `setActive(true)`, otherwise Android Auto refuses to
talk to the `MediaBrowserService`. That is unavoidable — but a session that never
plays stays behind Spotify in the routing order.

## Hard rules — getting Android Auto to see the app at all

### `android:resource`, never `android:value`

```xml
<meta-data
    android:name="com.google.android.gms.car.application"
    android:resource="@xml/automotive_app_desc" />
```

With `android:value` the app is **invisible** — not rejected with an error, not
greyed out, absent. It does not even appear in Android Auto's own "choose visible
apps" list, which is what makes this so confusing to diagnose: that list looks
like the authority on what AA can see, and the app never reaches it. This one
cost an evening.

### "Unknown sources" resets on every Android Auto update

A debug APK is only visible with Android Auto → ⋮ → developer settings →
**Unknown sources** checked. Enabling developer mode (ten taps on the version
number) only reveals the menu; the checkbox is separate. And it silently reverts
whenever Android Auto updates itself, so an app that worked last month can
vanish.

### Uninstall before reinstalling when debugging discovery

Android Auto caches which packages are media-capable. An install over the top
does not always make it re-evaluate. When changing anything about discovery —
the manifest metadata, the descriptor, the service declaration — uninstall,
install, force-stop Android Auto, reconnect.

## Hard rules — the tap

### `STATE_ERROR` is the feedback channel

After `onPlayFromMediaId`, Android Auto switches to its "now playing" screen and
waits for `STATE_PLAYING`. It never comes, so it spins forever and you have to
press Back to get out.

The fix is to answer **synchronously, before returning from the callback**, with
`STATE_ERROR` plus an error message. Android Auto shows the message and stays on
the browse tree. It is a deliberate abuse of the error channel — it is the only
channel AA reads without opening the player.

So the tap produces `DÉPART — envoi…` immediately, then
`DÉPART : 14:32:07 — OK (200)` when the HTTP response lands, then returns to a
neutral state after five seconds so no error banner stays stuck to the app.

This behaviour varies across Android Auto versions and head units. If a unit
still opens the player, the fallback is the browsable approach below, done
properly.

### Why the items are `FLAG_PLAYABLE` and not `FLAG_BROWSABLE`

Marking them browsable and firing the webhook from `onLoadChildren` avoids the
playback layer entirely, and looks cleaner. Two reasons it is a trap:

- Android Auto **prefetches** the children of browsable nodes to decide whether
  to show them. The gate would open by itself when the app opened.
- The subscription cache means a second tap on the same item does not necessarily
  call `onLoadChildren` again. The second trip home would do nothing.

`onPlayFromMediaId` is called on an explicit tap and only on an explicit tap. It
is deterministic, which matters more than elegance when the thing on the other
end is a gate.

## Build

The toolchain lives in WSL (Ubuntu). Nothing is needed on the Windows side.

```bash
cd /mnt/g/ZigbidouilleHomeyApp/android-auto
bash scripts/01-setup.sh     # JDK 17, Android SDK 34, Gradle 8.9 — once
bash scripts/02-build.sh     # compile; APK lands in dist/
bash scripts/03-install.sh   # optional, only if adb sees the phone
```

`01-setup.sh` is idempotent — rerun it freely, it skips what is already there.
It installs into `~/android-sdk` and `~/gradle-8.9`, accepts the Google SDK
licences, writes `local.properties`, and appends the environment variables to
`~/.bashrc`.

The APK is copied back to the Windows side of the project:

```
android-auto/dist/carhooks-debug.apk
```

Then get it onto the phone over USB, Quick Share, Drive — whatever is at hand —
and open it. Android asks once to allow installs from that source.

A release build (`bash scripts/02-build.sh release`) is signed with the debug key
on purpose. This app is never going near the Play Store, and a debug-signed APK
is exactly what Android Auto's "unknown sources" mode expects.

### WSL gotchas, all three of them hit

- **Gradle does not build on `/mnt/g`.** NTFS through WSL is several times slower
  and fumbles file locks. `02-build.sh` detects the `/mnt/` prefix, rsyncs the
  sources to `~/.carhooks-build`, builds there, and copies the APK back. You keep
  editing on the Windows side as usual. `--in-place` disables this.
- **`gradle wrapper` fails on `/mnt/g`** — it cannot set the executable bit on
  `gradlew` and dies with `Operation not permitted`. The wrapper is generated
  best-effort and its absence changes nothing; the scripts call the installed
  `gradle`. If you want the wrapper anyway, `bash gradlew` works without the exec
  bit.
- **WSL has no USB.** `adb` sees no device unless you share the port with
  `usbipd-win`. `03-install.sh` prints the three ways around it instead of
  failing with a bare error.

A fourth one, upstream of all of these: a Windows checkout must not hand bash
CRLF scripts. The repo's `.gitattributes` pins `*.sh` and `gradlew` to `eol=lf`,
because `set -euo pipefail\r` fails with nothing but `invalid option name`.

### Testing without a car

The phone UI covers the network layer, the URLs and the Flows — that is where
most bugs die. It does **not** exercise the `MediaBrowserService`: the old
"Android Auto on phone screen" mode was removed in Android 12.

For the browse tree itself, use the **Desktop Head Unit** — the official Android
Auto emulator, installed from Android Studio's SDK Manager (SDK Tools → Android
Auto Desktop Head Unit Emulator). Enable "Start head unit server" in Android
Auto's developer settings, then:

```bash
adb forward tcp:5277 tcp:5277
./desktop-head-unit
```

You get the real Android Auto interface on the PC, and you can run Spotify
alongside it to verify the audio-focus behaviour. What the DHU will *not* tell
you reliably is how a given head unit handles the post-tap screen — that one only
the car answers.

## Layout

```
android-auto/
  app/build.gradle.kts              module config — minSdk 26, compileSdk 34, viewBinding
  app/src/main/AndroidManifest.xml  the car metadata and the MediaBrowserService declaration
  app/src/main/java/com/bidouille/carhooks/
    Webhooks.kt                     ActionId enum, SharedPreferences store, HttpURLConnection sender
    MainActivity.kt                 the two buttons and the status line
    SettingsActivity.kt             one card per action: URL, GET/POST, JSON body, Test
    CarHooksMediaService.kt         the Android Auto surface — browse tree and tap handling
  app/src/main/res/
    layout/                         activity_main · activity_settings · block_action (one per action)
    drawable/                       the two action icons, the gear, the launcher foreground
    xml/automotive_app_desc.xml     <uses name="media"/> — what makes AA consider the app
  scripts/
    env.sh                          pinned versions and paths, sourced by the others
    01-setup.sh                     install the toolchain in WSL (idempotent)
    02-build.sh                     build off NTFS, APK copied back to dist/
    03-install.sh                   adb install, with the WSL-USB escape hatches
  dist/                             build output — gitignored
```

No external HTTP dependency: `HttpURLConnection` with an 8 second timeout is
enough to fire a webhook, and it keeps the APK small enough to transfer to the
phone over anything.

## Adding a third action

`ActionId` in `Webhooks.kt` is the single source of truth — the store, the
settings screen and the car tiles all derive from it. A new entry needs a key, a
label, and an icon in `iconUri()`, plus a card in `activity_settings.xml` and its
`bind()` call. The car side needs nothing: `onLoadChildren` already maps over
`ActionId.entries`.
