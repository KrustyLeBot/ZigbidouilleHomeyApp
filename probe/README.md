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

Zigbee devices have no folder here: the app's own **Settings → Zigbee dump**
already reports their endpoints and clusters, and Homey's radio is the only way
to reach them anyway.

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
