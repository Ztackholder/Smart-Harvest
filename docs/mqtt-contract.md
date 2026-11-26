# MQTT ingestion contract

## Existing wire behavior

The current committed `iot/SensorPublisher.ino` (commit `d27a15d`, 2026-11-25) publishes every 5000 ms to `tani/sensor/lingkungan` over the existing public HiveMQ TCP/QoS 0 flow. It now uses BME280 and emits `{temp,pres,hum,soil_pct,soil_raw}`. It does not include a timestamp, device ID, block ID or message ID. Thus the backend binds this topic to explicitly configured farm/device IDs; the broker message itself does not authenticate either identity. If a future payload includes `blok`, the value must match `MQTT_WIRE_BLOCK_ID`. Server receive time is recorded as such. The Apps Script timestamp is receipt time in a separate HTTP/Sheets path, not the MQTT measurement time. `iot/PayloadExample.json` uses longer aliases (`temperature`, `pressure`, `humidity`, `soil_percentage`) and is not the current sketch wire payload; these aliases are accepted for compatibility but not used as evidence of current firmware output.

## Wire-to-canonical mapping

| Wire key | Canonical field | Unit | Rule |
|---|---|---|---|
| configured blok | configured device_id binding | string | Optional; if present must match BLOK-A1. Never selects a farm from message data. |
| temp or temperature | air_temperature | C | finite -15..60 |
| pres or pressure | pressure | hPa | finite 300..1200, diagnostic only |
| soil_pct or soil_percentage | soil_moisture_index | percent | finite 0..100; not air humidity |
| soil_raw | soil_raw | ADC | finite 0..4095 for the 12-bit ESP32 |
| hum, humidity, humidity_pct, rh_pct or relative_humidity | relative_humidity | percent | optional, finite 0..100; accepted only when actually present in payload |
| absent timestamp | observed_at set to backend receive time | RFC3339 UTC | stored as server receive time, never as measured time |

Public input is stored as source=iot with provenance mqtt_public_unverified; local data is not physical sensor evidence. The public topic is unauthenticated, unencrypted and best effort. Values may be spoofed, duplicated, malformed, stale or unrelated to the demo farm. Ingestion is disabled by default, exact-topic only, limited to 4 KiB JSON, strict key/type/range validation, bounded queue, explicit farm/device binding, deduplication by explicit message ID when present, otherwise deterministic time-bound keys and controlled error logs. QoS 0 does not guarantee delivery. The backend does not publish to HiveMQ.

Defaults preserve host broker.hivemq.com, TCP port 1883, topic tani/sensor/lingkungan, QoS 0 and no credentials. Current mode is MQTT_ENABLED=false. Live mode requires configured MQTT_FARM_ID and MQTT_DEVICE_ID matching a seeded/configured Device record. The current publisher has no embedded block/device identity, so the topic-to-device mapping is an explicit deployment binding, not proof of physical origin. Configure `MQTT_SOURCE=simulated_iot` only when using the isolated local simulator; production/live mode uses `iot`. Optional username/password, TLS and websocket transport are configured for future brokers. Local Mosquitto uses the local-mqtt profile and has no host port. Tests never publish to the shared public topic.

The model aggregator uses a seven-day window [prediction_at - 7d, prediction_at), 15-minute slots (672 expected), at least 80% coverage per sensor and max 24-hour sample age. Repeated five-second readings in one slot do not add coverage. Missing humidity disables sensor-based full/air routes. Manual AI route remains distinct from the business MANUAL_ESTIMATE fallback. Synthetic fixture readings and live observations are not silently blended.

