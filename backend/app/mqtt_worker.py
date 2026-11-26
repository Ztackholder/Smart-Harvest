from __future__ import annotations
import json
import logging
import queue
import threading
import uuid
from datetime import datetime, timezone
from .core import session_factory, settings
from .services.svc_01_farm_data import FarmDataIntegrationService
from .services.svc_02_farm_record import FarmRecordService

log = logging.getLogger("smartharvest.mqtt")

ALIASES = {
    "temp": "air_temperature",
    "temperature": "air_temperature",
    "pres": "pressure",
    "pressure": "pressure",
    "soil_pct": "soil_moisture_index",
    "soil_percentage": "soil_moisture_index",
    "soil_raw": "soil_raw",
    "hum": "relative_humidity",
    "humidity": "relative_humidity",
    "humidity_pct": "relative_humidity",
    "rh_pct": "relative_humidity",
    "relative_humidity": "relative_humidity",
}
ALLOWED = {
    "blok",
    "temp",
    "temperature",
    "pres",
    "pressure",
    "soil_pct",
    "soil_percentage",
    "soil_raw",
    "hum",
    "humidity",
    "humidity_pct",
    "rh_pct",
    "relative_humidity",
    "timestamp",
    "message_id",
}


class MQTTWorker:
    def __init__(self):
        self.queue: queue.Queue[bytes] = queue.Queue(maxsize=256)
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
        self.client = None
        self.state = "disabled"
        self.last_received_at: str | None = None
        self.last_accepted_at: str | None = None
        self.accepted_count = 0
        self.rejected_count = 0
        self.dropped_count = 0
        self.last_error: str | None = None

    def status_snapshot(self) -> dict:
        return {
            "state": self.state,
            "last_received_at": self.last_received_at,
            "last_accepted_at": self.last_accepted_at,
            "accepted_count": self.accepted_count,
            "rejected_count": self.rejected_count,
            "dropped_count": self.dropped_count,
            "queue_size": self.queue.qsize(),
            "last_error": self.last_error,
        }

    def start(self):
        if not settings.mqtt_farm_id or not settings.mqtt_device_id:
            raise RuntimeError("MQTT farm/device binding is required")
        if settings.mqtt_transport not in {"tcp", "websocket"}:
            raise RuntimeError("MQTT transport must be tcp or websocket")
        if settings.mqtt_source not in {"iot", "simulated_iot"}:
            raise RuntimeError("MQTT_SOURCE must be iot or simulated_iot")
        import paho.mqtt.client as mqtt

        transport = "websockets" if settings.mqtt_transport == "websocket" else "tcp"
        client_id = settings.mqtt_client_id.strip() or f"smartharvest-sub-{uuid.uuid4().hex[:8]}"
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, transport=transport)
        self.client.reconnect_delay_set(min_delay=1, max_delay=60)
        if settings.mqtt_username:
            self.client.username_pw_set(settings.mqtt_username, settings.mqtt_password)
        if settings.mqtt_tls:
            self.client.tls_set()
        self.client.on_connect = self._connect
        self.client.on_disconnect = self._disconnect
        self.client.on_message = self._message
        self.state = "connecting"
        self.client.connect_async(settings.mqtt_host, settings.mqtt_port, keepalive=30)
        self.client.loop_start()
        self.thread = threading.Thread(target=self._consume, name="mqtt-persistence", daemon=True)
        self.thread.start()

    def _connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0:
            self.state = "connected"
            self.last_error = None
            client.subscribe(settings.mqtt_topic, qos=settings.mqtt_qos)
        else:
            self.state = "disconnected"
            self.last_error = f"broker_rejected:{reason_code}"
            log.warning("MQTT broker rejected connection (%s)", reason_code)

    def _disconnect(self, client, userdata, disconnect_flags, reason_code, properties=None):
        if not self.stop.is_set():
            self.state = "disconnected"

    def _message(self, client, userdata, msg):
        if msg.topic != settings.mqtt_topic or len(msg.payload) > 4096:
            self.rejected_count += 1
            return
        self.last_received_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        try:
            self.queue.put_nowait(bytes(msg.payload))
        except queue.Full:
            self.dropped_count += 1
            log.warning("MQTT ingestion queue full; dropping message")

    def normalize(self, raw: bytes) -> dict:
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict) or set(data) - ALLOWED:
            raise ValueError("unsupported MQTT fields")
        if data.get("blok") is not None and data["blok"] != settings.mqtt_wire_block_id:
            raise ValueError("wire identity mismatch")
        if "message_id" in data and (not isinstance(data["message_id"], str) or not 1 <= len(data["message_id"]) <= 128):
            raise ValueError("message_id is invalid")
        if data.get("timestamp"):
            observed = datetime.fromisoformat(data["timestamp"].replace("Z", "+00:00"))
            if observed.tzinfo is None or observed.utcoffset() is None:
                raise ValueError("timestamp requires timezone")
            timestamp_source = "wire"
        else:
            observed = datetime.now(timezone.utc)
            timestamp_source = "server_received_at"
        measurements = []
        seen_types: set[str] = set()
        for key, typ in ALIASES.items():
            if key not in data or typ in seen_types:
                continue
            value = data[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("measurement must be numeric")
            unit = {
                "air_temperature": "C",
                "pressure": "hPa",
                "soil_moisture_index": "percent",
                "soil_raw": "ADC",
                "relative_humidity": "percent",
            }[typ]
            seen_types.add(typ)
            measurements.append({"type": typ, "value": value, "unit": unit})
        if not measurements:
            raise ValueError("no supported measurements")
        return {
            "farm_id": settings.mqtt_farm_id,
            "device_id": settings.mqtt_device_id,
            "crop_id": settings.mqtt_crop_id or None,
            "observed_at": observed,
            "observed_at_source": timestamp_source,
            "source": settings.mqtt_source,
            "provenance": (
                "local_simulator"
                if settings.mqtt_source == "simulated_iot"
                else "mqtt_public_unverified"
                if settings.mqtt_host == "broker.hivemq.com"
                else "mqtt_configured"
            ),
            "message_id": data.get("message_id"),
            "measurements": measurements,
        }

    def _consume(self):
        while not self.stop.is_set():
            try:
                raw = self.queue.get(timeout=0.25)
            except queue.Empty:
                continue
            session = session_factory()()
            try:
                payload = self.normalize(raw)
                FarmDataIntegrationService(session, FarmRecordService(session)).submit_observation(
                    payload, device_authorized=True
                )
                session.commit()
                self.accepted_count += 1
                self.last_accepted_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            except Exception as exc:
                session.rollback()
                self.rejected_count += 1
                self.last_error = type(exc).__name__
                log.warning("Rejected MQTT message (%s)", type(exc).__name__)
            finally:
                session.close()
                self.queue.task_done()

    def close(self):
        self.stop.set()
        self.state = "disabled"
        if self.client:
            try:
                self.client.disconnect()
            except Exception:
                pass
            try:
                self.client.loop_stop()
            except Exception:
                pass
        if self.thread:
            self.thread.join(timeout=2)
