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
| endpoint | `1` | assumed standard Heiman IAS layout |
| input clusters | `0` basic, `1` power config, `3` identify, `1280` IAS Zone | assumed — re-check per-endpoint list in the tool if alarms don't arrive |
| IAS `zoneType` | `0x000B` (Carbon Monoxide Sensor) | assumed |

Raw interview row: IEEE `b0:e8:e8:ff:fe:65:f8:f7`, NWK `51717 (CA05)`,
`enddevice`, battery ~10%.

Alarm delivery: IAS Zone `zoneStatusChangeNotification` command (not attribute
reporting). `zoneStatus` bits used: `alarm1` → CO, `battery` → low battery.
See `app/drivers/co-hs720es/device.js`.

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
