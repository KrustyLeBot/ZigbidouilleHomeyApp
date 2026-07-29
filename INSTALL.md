# Installing on Homey

## One-time setup

The CLI version must match the Node version — mismatching them breaks every
command, including `--version`:

| Node | CLI | why |
|------|-----|-----|
| >= 24 | `homey` (4.x) | `homey-api` requires Node >= 24 |
| 22 | `homey@3` | v4 throws `ERR_REQUIRE_ESM` on every command |

On Node 22, the "Update available 3.x → 4.x" banner is a trap: npm only warns
about the engine mismatch and installs anyway. Roll back with
`npm install -g homey@3`. Apps already on the Homey are unaffected — only the
local CLI breaks.

Then log in — this opens a browser:

```powershell
homey login
```

## Install

Run every command **from the `app` folder** — the CLI looks for `app.json` in
the current directory and fails with ENOENT anywhere else.

```powershell
cd G:\ZigbidouilleHomeyApp\app
npm install
homey app install
```

`npm install` pulls `homey-zigbeedriver` and `zigbee-clusters`. The app stays on
the Homey after the terminal closes.

### `homey app run` needs Docker

`homey app run` emulates the app locally and **requires Docker Desktop**
(`Could not connect to Docker` without it). `homey app install` uploads straight
to the Homey and does not. Docker is worth installing here anyway: live logs are
how you watch a device bind to a driver and see which clusters actually report.

Without it, read logs from: Homey app → Apps → Zigbidouille → Logs.

## Pairing a device

Homey app → Devices → + → Zigbidouille → *(pick the driver for your device)*.

Follow the on-screen instruction to put the device into Zigbee join mode
(usually: hold its button until the LED blinks). Keep the device within a few
metres of the Homey (or a mains-powered router node) during the join.

If the device pairs but as a nameless generic node instead of your driver, the
fingerprint (`manufacturerName` / `productId`) in `app.json` does not match what
the device announced — re-read it in **Developer Tools → Zigbee** and fix it.
See [CLAUDE.md](CLAUDE.md).

## Notes

- Placeholder images and icons are generated solid colours; replace them with
  real artwork before publishing anywhere.
- `homey app validate --level publish` must pass before submitting to the App
  Store; `--level debug` is enough for local install.
