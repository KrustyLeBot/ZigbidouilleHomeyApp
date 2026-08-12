# probe/ — talking to devices without Homey

Standalone scripts for protocol work. They run on your machine and speak to the
device directly, so there is no app to reinstall between attempts — by far the
fastest loop when reverse-engineering something.

**One subfolder per device**, named after its driver:

| Folder | Device | Protocol | `.env` prefix |
|---|---|---|---|
| [`x20plus/`](x20plus) | Xiaomi Robot Vacuum X20+ (`c102gl`) | miIO (UDP + AES-128) | `ROBOT_` |
| [`vacuum5/`](vacuum5) | Xiaomi Robot Vacuum 5 (`ov31gl`) | miIO (UDP + AES-128) | `VACUUM5_` |
| [`devialet/`](devialet) | Devialet Phantom II | mDNS + local HTTP | — |
| [`imou/`](imou) | Imou cameras (Ranger 2C, Cell PT) | Imou Open Platform (HTTPS, cloud) | `IMOU_` |
| [`somfy/`](somfy) | Somfy Protect alarm | unofficial reverse-engineered HTTPS + websocket, cloud | `SOMFY_` |
| [`homey/`](homey) | Homey itself — its Insights logs | local Web API (HTTP + Personal Access Token) | `HOMEY_` |

Zigbee devices have no folder here: the app's own **Settings → Zigbee dump**
already reports their endpoints and clusters, and Homey's radio is the only way
to reach them anyway.

`homey/` is the odd one out — the "device" it interviews is the Homey. It exists
because the Shelly widget's Insights backfill depends on how a log is
**addressed**, which no document states: `insights.js` lists every log with its
real `id` / `ownerUri` / `ownerId`, and optionally fetches today's entries
through both candidate path shapes so a 404 is visible as a 404.

```bash
cd probe/homey
node insights.js                 # every log, grouped by device
node insights.js shelly entries  # only Shelly, and try fetching today
```

## Conventions for a new subfolder

- Keep its own `package.json` — these scripts are not part of the Homey app and
  must not drag dependencies into it.
- Read credentials through [`../env.js`](env.js) — `requireCredentials('PREFIX',
  args)` resolves `PREFIX_IP` / `PREFIX_TOKEN` from the repo-root `.env`
  (gitignored), lets CLI arguments override, and rejects a malformed token up
  front instead of letting it surface as an unexplained handshake timeout.
  Never hardcode a token, never print one.

  Each script used to carry its own copy of the loader, and that copy matched
  keys with `[A-Z_]+` — so `VACUUM5_IP` was silently skipped and read as unset.
  One shared loader, with digits allowed.
- Say in a header comment what question the script answers. `sweep.js` exists
  because a published spec was wrong; that context is what makes it reusable.
