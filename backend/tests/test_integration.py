from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.app.core import Base, Principal, Record, Settings, configure_database, settings
from backend.app.mqtt_worker import MQTTWorker
from backend.app.schemas import ActualIn, EstimateIn, ObservationIn
from backend.app.sensor_aggregation import aggregate_observations
from backend.app.services.svc_01_farm_data import FarmDataIntegrationService
from backend.app.services.svc_02_farm_record import FarmRecordService

ROOT = Path(__file__).resolve().parents[2]


def login_headers(client: TestClient, username: str, password: str) -> dict[str, str]:
    response = client.post("/api/v1/auth/login", headers={"Origin": "http://localhost"},
                           json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return {"Cookie": f"smartharvest_session={response.cookies['smartharvest_session']}",
            "X-CSRF-Token": response.json()["csrf_token"]}


def fixture_observations(sample_id: str) -> list[dict]:
    grouped: dict[tuple[str, str], dict] = {}
    with (ROOT / "datasets/data/v3/fixtures/sensor_raw_fixture.csv").open(encoding="utf-8", newline="") as stream:
        for row in csv.DictReader(stream):
            if row["sample_id"] != sample_id:
                continue
            key = (row["sample_id"], row["observed_at"])
            observation = grouped.setdefault(key, {
                "observed_at": row["observed_at"], "source": row["source"], "measurements": []
            })
            value: float | str = row["value"]
            try:
                value = float(value)
            except ValueError:
                pass
            observation["measurements"].append({
                "type": row["measurement_type"], "value": value, "unit": row["unit"]
            })
    return list(grouped.values())


def test_aggregation_matches_dataset_v3_fixtures():
    expected = json.loads((ROOT / "datasets/data/v3/fixtures/sensor_fixture_expected.json").read_text(encoding="utf-8"))
    for sample_id in ("complete", "missing_interval", "stale"):
        fixture = expected[sample_id]
        end = datetime.fromisoformat(fixture["window_end_exclusive"])
        result = aggregate_observations(fixture_observations(sample_id), end)
        assert result["quality"] == fixture["quality"]
        assert result["rejected"] == fixture["rejected"]
        for key in ("air_temp_mean_7d_c", "air_temp_max_7d_c", "humidity_mean_7d_pct",
                    "soil_moisture_mean_7d_pct", "soil_moisture_min_7d_pct"):
            assert result["features"].get(key) == fixture[key]
        assert result["valid_sensor_readings_7d"] == fixture["valid_sensor_readings_7d"]


def test_mqtt_normalizes_teammate_humidity_and_receive_time():
    worker = MQTTWorker()
    wire = {"temp": 27.8, "pres": 927.35, "hum": 68.5, "soil_pct": 34, "soil_raw": 2580}
    normalized = worker.normalize(json.dumps(wire).encode())
    assert normalized["observed_at_source"] == "server_received_at"
    assert normalized["farm_id"] == settings.mqtt_farm_id
    assert normalized["device_id"] == settings.mqtt_device_id
    assert {m["type"]: m["value"] for m in normalized["measurements"]}["relative_humidity"] == 68.5
    assert "blok" not in wire
    old_message = json.loads((ROOT / "backend/tests/fixtures/hivemq_sensor_message.json").read_text(encoding="utf-8"))
    old_normalized = worker.normalize(json.dumps(old_message).encode())
    assert not any(item["type"] == "relative_humidity" for item in old_normalized["measurements"])


def test_mqtt_accepts_documented_long_aliases_and_rejects_wrong_block():
    worker = MQTTWorker()
    result = worker.normalize(b'{"temperature":27.8,"pressure":927.3,"humidity":68.5,"soil_percentage":34,"soil_raw":2580}')
    assert {m["type"] for m in result["measurements"]} == {
        "air_temperature", "pressure", "relative_humidity", "soil_moisture_index", "soil_raw"
    }
    with pytest.raises(ValueError, match="wire identity mismatch"):
        worker.normalize(b'{"blok":"OTHER-BLOCK","temp":27.8}')
    with pytest.raises(ValueError, match="unsupported MQTT fields"):
        worker.normalize(b'{"temp":27.8,"farm_id":"FARM-OTHER"}')


def test_timestamp_schemas_require_timezone():
    with pytest.raises(ValueError):
        EstimateIn.model_validate({"farm_id":"FARM-01","crop_id":"SPINACH","harvest_period":"2026-W48","estimated_quantity_kg":2,"recorded_at":"2026-11-25T08:00:00"})
    with pytest.raises(ValueError):
        ActualIn.model_validate({"farm_id":"FARM-01","crop_id":"SPINACH","period":"2026-W48","actual_quantity_kg":2,"harvested_at":"2026-11-25T08:00:00","source":"manual","confirmation_note":"checked"})
    ObservationIn.model_validate({"farm_id":"FARM-01","observed_at":"2026-11-25T08:00:00Z","source":"manual","measurements":[{"type":"air_temperature","value":27,"unit":"C"}]})


def test_mqtt_observation_uses_configured_device_and_message_id_dedup(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path.as_posix()}/iot.sqlite", connect_args={"check_same_thread":False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        farm = FarmRecordService(session)
        farm.seed()
        service = FarmDataIntegrationService(session, farm)
        observed = datetime(2026, 11, 25, 8, 0, tzinfo=timezone.utc)
        payload = {
            "farm_id":"FARM-01", "device_id":"BLOK-A1", "crop_id":"SPINACH", "observed_at":observed,
            "source":"iot", "message_id":"msg-1", "measurements":[{"type":"relative_humidity","value":68.5,"unit":"percent"}]
        }
        result = service.submit_observation(dict(payload), device_authorized=True)
        assert result["measurements"][0]["type"] == "relative_humidity"
        with pytest.raises(HTTPException) as duplicate:
            service.submit_observation(dict(payload), device_authorized=True)
        assert duplicate.value.status_code == 409
        with pytest.raises(HTTPException) as spoofed:
            service.submit_observation({**payload, "farm_id":"FARM-OTHER"}, device_authorized=True)
        assert spoofed.value.status_code == 403
    engine.dispose()


def test_http_manual_estimate_approval_selection_and_feedback(tmp_path, monkeypatch):
    from backend.app.main import app

    monkeypatch.setattr(settings, "database_url", f"sqlite:///{tmp_path.as_posix()}/api.sqlite")
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "public_profile", False)
    monkeypatch.setattr(settings, "trusted_hosts", "localhost,127.0.0.1,testserver")
    monkeypatch.setattr(settings, "model_enabled", False)
    monkeypatch.setattr(settings, "session_cookie_secure", False)
    for name, password in (("farmer", "test-farmer-password-123"), ("coordinator", "test-coordinator-password-123"),
                           ("member-eligible", "test-eligible-password-123"), ("member-regular", "test-regular-password-123")):
        monkeypatch.setitem(settings.__dict__, f"auth_bootstrap_{'member_eligible' if name == 'member-eligible' else 'member_regular' if name == 'member-regular' else name}_username", name)
        monkeypatch.setitem(settings.__dict__, f"auth_bootstrap_{'member_eligible' if name == 'member-eligible' else 'member_regular' if name == 'member-regular' else name}_password", password)

    with TestClient(app, headers={"host":"localhost"}) as client:
        farmer = login_headers(client, "farmer", "test-farmer-password-123")
        coordinator = login_headers(client, "coordinator", "test-coordinator-password-123")
        member = login_headers(client, "member-eligible", "test-eligible-password-123")
        regular = login_headers(client, "member-regular", "test-regular-password-123")
        observation = client.post("/api/v1/farm-observations", headers=farmer, json={
            "farm_id":"FARM-01", "crop_id":"SPINACH", "observed_at":"2026-11-25T07:55:00Z", "source":"manual",
            "measurements":[{"type":"air_temperature","value":27.8,"unit":"C"}]
        })
        assert observation.status_code == 201, observation.text
        invalid = client.post("/api/v1/farm-observations", headers=farmer, json={
            "farm_id":"FARM-01", "observed_at":"2026-11-25T07:56:00Z", "source":"manual",
            "measurements":[{"type":"relative_humidity","value":101,"unit":"percent"}]
        })
        assert invalid.status_code == 422 and invalid.json()["error"]["code"] == "MEASUREMENT_OUT_OF_RANGE"
        estimate = client.post("/api/v1/harvest-estimates", headers=farmer, json={
            "farm_id":"FARM-01", "crop_id":"SPINACH", "harvest_period":"2026-W48",
            "estimated_quantity_kg":10, "recorded_at":"2026-11-25T08:00:00Z"
        })
        assert estimate.status_code == 201, estimate.text
        estimate_id = estimate.json()["estimate_id"]
        unavailable = client.post("/api/v1/harvest-predictions", headers=coordinator, json={
            "farm_id":"FARM-01", "crop_id":"SPINACH", "target_period":"2026-W48", "data_reference_ids":[estimate_id]
        })
        assert unavailable.status_code == 503
        assert unavailable.json()["error"]["code"] == "PREDICTION_UNAVAILABLE"
        forbidden_approval = client.post("/api/v1/approved-availability", headers=member, json={"farm_id":"FARM-01","crop_id":"SPINACH","period":"2026-W48","basis_type":"MANUAL_ESTIMATE","basis_id":estimate_id,"approved_quantity_kg":10,"approval_note":"forbidden"})
        assert forbidden_approval.status_code == 403
        approved = client.post("/api/v1/approved-availability", headers=coordinator, json={
            "farm_id":"FARM-01", "crop_id":"SPINACH", "period":"2026-W48", "basis_type":"MANUAL_ESTIMATE",
            "basis_id":estimate_id, "approved_quantity_kg":10, "approval_note":"coordinator review"
        })
        assert approved.status_code == 201, approved.text
        availability_id = approved.json()["availability_id"]
        assert client.get("/api/v1/approved-availability?period=2026-W48", headers=member).status_code == 200
        actual = client.post("/api/v1/actual-harvests", headers=coordinator, json={
            "farm_id":"FARM-01", "crop_id":"SPINACH", "period":"2026-W48", "actual_quantity_kg":8,
            "harvested_at":"2026-11-26T08:00:00Z", "source":"coordinator-confirmed", "confirmation_note":"weighed"
        })
        assert actual.status_code == 201, actual.text
        adjustment = {"availability_id":availability_id,"expected_version":1,"approved_quantity_kg":8,"reason":"align with confirmed actual","member_allocations":[{"member_id":"MBR-001","quantity_kg":1},{"member_id":"MBR-002","quantity_kg":1}],"actual_harvest_id":actual.json()["actual_harvest_id"]}
        stale = client.post("/api/v1/allocation-adjustments", headers=coordinator, json={**adjustment,"expected_version":99})
        assert stale.status_code == 409
        adjusted = client.post("/api/v1/allocation-adjustments", headers=coordinator, json=adjustment)
        assert adjusted.status_code == 201, adjusted.text
        assert adjusted.json()["version"] == 2
        actual_list = client.get("/api/v1/actual-harvests?farm_id=FARM-01&period=2026-W48", headers=coordinator)
        assert actual_list.status_code == 200 and len(actual_list.json()["items"]) == 1
        denied = client.post("/api/v1/member-selections", headers=regular, json={
            "period":"2026-W48", "items":[{"availability_id":availability_id,"availability_version":2,"quantity_kg":1}]
        })
        assert denied.status_code == 403
        selected = client.post("/api/v1/member-selections", headers=member, json={
            "period":"2026-W48", "items":[{"availability_id":availability_id,"availability_version":2,"quantity_kg":1}]
        })
        assert selected.status_code == 201, selected.text
        rejected_feedback = client.post("/api/v1/member-feedback", headers=regular, json={"period":"2026-W48","comment":"received"})
        assert rejected_feedback.status_code == 409
        receipt = client.post("/api/v1/package-receipts", headers=coordinator, json={"member_id":"MBR-002","period":"2026-W48","confirmed":True})
        assert receipt.status_code == 201
        feedback = client.post("/api/v1/member-feedback", headers=regular, json={"period":"2026-W48","comment":"received"})
        assert feedback.status_code == 201, feedback.text
        assert client.get("/api/v1/approved-availability?period=2026-W48", headers={"Cookie": ""}).status_code == 401








def test_existing_model_prediction_is_stored_and_retrievable(tmp_path, monkeypatch):
    from backend.app.main import app

    monkeypatch.setattr(settings, "database_url", f"sqlite:///{tmp_path.as_posix()}/model.sqlite")
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "public_profile", False)
    monkeypatch.setattr(settings, "model_enabled", True)
    monkeypatch.setattr(settings, "model_path", "ai/models/model.joblib")
    monkeypatch.setattr(settings, "session_cookie_secure", False)
    for name, password in (("farmer", "test-farmer-password-model-123"), ("coordinator", "test-coordinator-password-model-123"),
                           ("member-eligible", "test-eligible-password-model-123"), ("member-regular", "test-regular-password-model-123")):
        suffix = "member_eligible" if name == "member-eligible" else "member_regular" if name == "member-regular" else name
        monkeypatch.setitem(settings.__dict__, f"auth_bootstrap_{suffix}_username", name)
        monkeypatch.setitem(settings.__dict__, f"auth_bootstrap_{suffix}_password", password)

    with TestClient(app, headers={"host":"localhost"}) as client:
        farmer = login_headers(client, "farmer", "test-farmer-password-model-123")
        coordinator = login_headers(client, "coordinator", "test-coordinator-password-model-123")
        estimate = client.post("/api/v1/harvest-estimates", headers=farmer, json={
            "farm_id":"FARM-01", "crop_id":"SPINACH", "harvest_period":"2026-W48",
            "estimated_quantity_kg":10, "recorded_at":"2026-11-25T08:00:00Z"
        })
        assert estimate.status_code == 201, estimate.text
        prediction = client.post("/api/v1/harvest-predictions", headers=coordinator, json={
            "farm_id":"FARM-01", "crop_id":"SPINACH", "target_period":"2026-W48",
            "data_reference_ids":[estimate.json()["estimate_id"]]
        })
        assert prediction.status_code == 201, prediction.text
        body = prediction.json()
        assert body["status"] == "generated"
        assert body["model_version"] == "rf-synthetic-v3"
        assert body["source_of_training_data"] == "synthetic"
        assert body["inference_route"] == "manual"
        fetched = client.get(f"/api/v1/harvest-predictions/{body['prediction_id']}", headers=coordinator)
        assert fetched.status_code == 200 and fetched.json()["prediction_id"] == body["prediction_id"]
        member = login_headers(client, "member-eligible", "test-eligible-password-model-123")
        member_read = client.get(f"/api/v1/harvest-predictions/{body['prediction_id']}", headers=member)
        assert member_read.status_code == 403

