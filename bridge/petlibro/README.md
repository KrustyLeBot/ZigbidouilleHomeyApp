# petlibro-bridge

Stands in for the Petlibro cloud on the LAN, so a **Petlibro One RFID Smart
Feeder (PLAF301)** works with no account and no internet, driven from Homey
(`app/drivers/petlibro-plaf301`) and from its own web page.

```
feeder ──MQTT 1883──▶ petlibro-bridge (NAS) ◀──HTTP/WS 8484── Homey, browser
   └── DNS: mqtt.us.petlibro.com ──▶ AdGuard Home (NAS) ──▶ NAS LAN IP
```

What it does in place of the cloud: answers the feeder's time requests (with
DST data) and corrects its clock without skipping or repeating a meal, acks the
boot and dispense events, keeps the meal schedule (local time) and sends the
feeder its UTC plans — again after every reboot and every DST change — and polls
its state every 5 minutes. Protocol from
[smcneece/petlibro-local](https://github.com/smcneece/petlibro-local) (MIT).

## Endpoints (port 8484, all behind the htpasswd login except `/health`)

| | |
|---|---|
| `GET /` | control page: state, feed, lid, settings, schedule editor, log |
| `GET /api/feeders`, `GET /api/feeders/:serial` | snapshots |
| `POST /api/feeders/:serial/feed` `{portions}` | serve now (1..10) |
| `POST /api/feeders/:serial/lid` `{open}` | open / close the lid |
| `POST /api/feeders/:serial/settings` | `lidMode` (`CUSTOM`/`KEEP_OPEN`/`KEEP_CLOSE`), `lidCloseDelay` 1..10, `lidCloseSpeed` (`FAST`/`SLOW`), `childLock`, `sound`, `volume` 0..100, `displayOn` |
| `PUT /api/feeders/:serial/schedule` | `{meals:[{time:"HH:MM", days:[1..7], portions}], timezone, callSound}` — up to 6 meals, local time |
| `POST /api/feeders/:serial/schedule/paused` `{paused}` | pause sends an empty plan list; resume re-sends the schedule |
| `POST /api/feeders/:serial/display` `{text}` | LED text, A-Z 0-9 space, 20 chars |
| `GET /api/log`, `GET /api/capture?serial=` | bridge log, raw MQTT capture |
| `WS /api/events` | `hello`, then `state` / `event` pushes (what Homey listens to) |
| `GET /health` | liveness, used by the Docker healthcheck |

MQTT (1883): a client whose id is a Petlibro serial is accepted as a feeder
(its Petlibro login is not checked) and fenced to its own `dl/<model>/<serial>/`
topics; `ALLOWED_SERIALS` narrows that to known units. An htpasswd login gets
full access, for MQTT Explorer.

## Configuration

Environment (`.env`, see `.env.example`): `PUID`/`PGID`, `API_PORT`,
`ALLOWED_SERIALS`, `LOG_LEVEL=debug`. In the image: `TZ` (default timezone,
Europe/Paris — Homey sends its own with the schedule), `DATA_DIR=/data`,
`HTPASSWD_FILE=/auth/htpasswd`.

`auth/htpasswd` takes bcrypt lines, as written by `htpasswd -nbB user password`
(re-read on change, no restart needed). `/data` holds `state.json` (schedules,
settings) and `capture.jsonl` (raw MQTT, 2 × 5 MB rotated).

## Deploy

`docker-compose.yml` here is the Synology version. The DNS rewrite, the router
side and the Homey side are in the main [README](../../README.md#petlibro-one-rfid-smart-feeder-petlibro-plaf301--lan-mqtt-via-petlibro-bridge).

Restarting the container makes the feeders reboot: update it away from meal
times. Meals already stored on the feeder still run while the bridge is down.

## Develop

```bash
npm install
npm test        # unit tests + an end-to-end run against a fake feeder
```
