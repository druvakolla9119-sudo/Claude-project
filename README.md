# Sensor Report System v3

Devices send raw telemetry. It is decoded and cleaned, then stored with a registry of each device and its channels, and turned into insight reports (JSON or PDF) over any period.

```
Device (HTTP / MQTT) ─► /api/ingest ─► decode ─► scale & validate ─► SQLite
                                                                        │
             Admin ─► /api/devices (registry)   /api/reports/stored ◄───┘
```

## Run
Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`, so there's no database server to install).
```
npm install
cp .env.example .env      # set ADMIN_TOKEN
npm test
npm start                 # http://localhost:3000
```

## 1. Register a device
```bash
curl -X POST localhost:3000/api/devices -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{
  "id": "meter-01", "name": "Main meter", "type": "energy-meter", "location": "Plant A",
  "channels": [
    { "channel": "power",   "unit": "W",   "minValid": 0, "maxValid": 50000 },
    { "channel": "voltage", "unit": "V" },
    { "channel": "temp",    "unit": "C",   "scale": 0.01, "offset": -40 }
  ]
}'
```
The response contains `apiKey` (`sk_dev_...`). It's shown **once** and stored hashed.

Channel settings:
- `scale` / `offset` convert raw counts into engineering units: `value = raw × scale + offset`.
- `minValid` / `maxValid` reject readings that are physically impossible.
- `autoChannels` (default `true`) creates new channels automatically the first time a device sends them.

## 2. Send data (from any microcontroller)
`POST /api/ingest`. Authenticate with `X-API-Key: sk_dev_...`, `Authorization: Bearer ...`, or `?key=`.

| Format | Example |
|---|---|
| Flat JSON | `{"ts": 1790000000, "power": 1234, "voltage": 230.1}` |
| Compact JSON | `{"ts": 1790000000, "values": {"power": 1234}}` |
| Long JSON | `[{"channel":"power","value":1234,"timestamp":"2026-09-28T10:00:00Z"}]` |
| CSV | `timestamp,channel,value` rows, or wide `timestamp,power,voltage` columns |
| Binary | `application/octet-stream`, hex text, or `{"data":"<base64>"}`, decoded with the device's `binaryLayout` |

- **Timestamps:** ISO strings, epoch seconds or epoch ms are all accepted. If a device has no clock, leave the timestamp out and the server's receive time is used. Timestamps more than 5 minutes in the future, or older than about 13 months, are rejected.
- **Retries are safe:** readings are de-duplicated on device + channel + timestamp.
- **Response:** `{ accepted, duplicates, rejected, rejectionReasons }`. The status is `422` when every reading in the request was rejected, `401` for a bad key, `403` for a disabled device, and `429` when the rate limit is hit.

Binary layout example for a LoRa-style node that sends records made of a `uint32` timestamp, a `uint16` power value and an `int16` temperature (×0.1):
```json
{ "payloadFormat": "binary",
  "binaryLayout": { "timestamp": { "type": "uint32be" },
                    "fields": [ { "channel": "power", "type": "uint16be" }, { "channel": "temp", "type": "int16be" } ] },
  "channels": [ { "channel": "temp", "unit": "C", "scale": 0.1 } ] }
```
Supported types: `int8`, `uint8`, `(u)int16be/le`, `(u)int32be/le`, `float32be/le`, `float64be/le`.

Examples:
- `examples/esp32_energy_meter.ino` is a firmware sketch for an ESP32.
- `examples/esp32_smoke_sensor/esp32_smoke_sensor.ino` is ready-to-flash ESP32 + MQ-2 smoke sensor firmware (see below).
- `npm run simulate -- <API_KEY>` runs a simulated meter.

### ESP32 smoke sensor (MQ-2)
1. **Wire it:** MQ-2 `VCC`→`5V/VIN`, `GND`→`GND`, `AO`→10 kΩ→`GPIO34`→20 kΩ→`GND`. The divider is required because AO reaches 5 V. Active buzzer on `GPIO25`, LED (with 220 Ω) on `GPIO26`.
2. **Register the device.** The channel list is at the top of the sketch. Copy the returned `apiKey`.
3. **Edit** `WIFI_SSID`, `WIFI_PASS`, `API_URL`, and `API_KEY` in the sketch. Then open it in the Arduino IDE (board: *ESP32 Dev Module*, esp32 core 2.x or 3.x, no extra libraries) and upload.
4. **First boot, in clean air:** the LED blinks for 60 s while the heater warms up. Then the sketch calibrates R0 and saves it to flash. To recalibrate later, press **BOOT** while the LED is blinking.

It samples every second and reports every 30 s: `smoke_ppm` (average), `smoke_ppm_max`, `alarm` (0/1), `sensor_fault` (0/1), `rs_r0`, and `rssi`. It also reports immediately when the alarm turns on or off. The buzzer/LED alarm switches on at ≥400 ppm and off below 250 ppm, and it works without Wi-Fi. While the server can't be reached, it buffers up to 60 reports and sends them once the connection is back. A new MQ-2 needs 24–48 h of burn-in before its readings settle. This sketch is a monitoring device, not a certified smoke alarm, so don't use it in place of one.

### MQTT (optional)
1. Run `npm install mqtt` and set `MQTT_URL`.
2. Devices publish to `devices/<id>/telemetry`, and results come back on `devices/<id>/ack`.

The broker must authenticate devices and restrict each one to its own topic (for Mosquitto: `pattern write devices/%u/telemetry`).

## 3. Manage devices and read data (admin token)
| | |
|---|---|
| `GET /api/devices` | list |
| `GET /api/devices/:id` | details, channels, latest values, recent ingest log |
| `PATCH /api/devices/:id` | update (for example `{"status":"disabled"}`) |
| `DELETE /api/devices/:id` | delete the device **and its readings** |
| `POST /api/devices/:id/rotate-key` | new API key; the old one stops working immediately |
| `PUT /api/devices/:id/channels/:channel` | create or update a channel |
| `DELETE /api/devices/:id/channels/:channel` | delete a channel and its readings |
| `GET /api/devices/:id/readings?channel=&from=&to=&limit=` | raw stored readings |

## 4. Reports from stored history
```
GET /api/reports/stored?devices=meter-01,temp-01&channels=power&from=2026-09-01&to=2026-09-28&format=pdf
```
- `format=json` returns the insights instead of a PDF.
- The default period is the last 24 hours.
- `anomalyThreshold` and `gapFactor` can also be passed as query parameters.

The v2 upload endpoints still work: `POST /api/reports/process` and `POST /api/reports/generate`.

## Configuration (.env)
| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_TOKEN` | random per run (required in production) | protects the admin API |
| `DB_PATH` | `./data/sensors.db` | SQLite file |
| `INGEST_PER_MINUTE` | 600 | per-device rate limit |
| `RETENTION_DAYS` | 0 (keep forever) | purge older readings |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` | - | enable the MQTT bridge |

## Scaling notes
- SQLite (WAL mode) handles a single server with thousands of readings per second.
- All SQL lives in `src/db/`. To move to PostgreSQL/TimescaleDB for multi-server or very large deployments, re-implement `deviceRepo.js` and `readingRepo.js`.
- The rate limiter is in memory. Use Redis when running several instances.
- The admin token is a stop-gap until user accounts (multi-tenant) are added.
