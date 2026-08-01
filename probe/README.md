# probe/ — talking to devices without Homey

Standalone scripts for protocol work. They run on your machine and speak to the
device directly, so there is no app to reinstall between attempts — by far the
fastest loop when reverse-engineering something.

**One subfolder per device**, named after its driver:

| Folder | Device | Protocol |
|---|---|---|
| [`x20plus/`](x20plus) | Xiaomi Robot Vacuum X20+ | miIO (UDP + AES-128) |

Zigbee devices have no folder here: the app's own **Settings → Zigbee dump**
already reports their endpoints and clusters, and Homey's radio is the only way
to reach them anyway.

## Conventions for a new subfolder

- Keep its own `package.json` — these scripts are not part of the Homey app and
  must not drag dependencies into it.
- Read credentials from the repo-root `.env` (gitignored), resolved as
  `path.join(__dirname, '..', '..', '.env')` from inside the subfolder. Never
  hardcode a token, never print one.
- Say in a header comment what question the script answers. `sweep.js` exists
  because a published spec was wrong; that context is what makes it reusable.
