from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient

from backend.app.core import Record, save, session_factory, settings
from backend.app.main import app
from backend.app.prediction_scheduler import PredictionScheduler
from backend.app.services.svc_02_farm_record import FarmRecordService
from backend.app.services.svc_03_prediction import HarvestPredictionService


def _setup_env(monkeypatch, tmp_path, *, model_enabled: bool = False):
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{tmp_path.as_posix()}/rem.sqlite")
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "public_profile", False)
    monkeypatch.setattr(settings, "trusted_hosts", "localhost,127.0.0.1,testserver")
    monkeypatch.setattr(settings, "model_enabled", model_enabled)
    monkeypatch.setattr(settings, "mqtt_enabled", False)
    monkeypatch.setattr(settings, "prediction_scheduler_enabled", False)
    monkeypatch.setattr(settings, "session_cookie_secure", False)
    creds = (
        ("farmer", "rem-farmer-password-123456"),
        ("coordinator", "rem-coordinator-password-123"),
        ("member-eligible", "rem-eligible-password-1234"),
        ("member-regular", "rem-regular-password-12345"),
    )
    for name, pw in creds:
        suffix = "member_eligible" if name == "member-eligible" else "member_regular" if name == "member-regular" else name
        monkeypatch.setitem(settings.__dict__, f"auth_bootstrap_{suffix}_username", name)
        monkeypatch.setitem(settings.__dict__, f"auth_bootstrap_{suffix}_password", pw)


def _login(client: TestClient, username: str, password: str) -> dict[str, str]:
    res = client.post(
        "/api/v1/auth/login",
        headers={"Origin": "http://localhost"},
        json={"username": username, "password": password},
    )
    assert res.status_code == 200, res.text
    return {
        "Cookie": f"smartharvest_session={res.cookies['smartharvest_session']}",
        "X-CSRF-Token": res.json()["csrf_token"],
    }


def _seed_sensor_slots(slot_count: int, end: datetime, *, include_humidity: bool = True, farm_id: str = "FARM-01"):
    """Insert deterministic 15-minute slot observations directly into SQLite for fast B01 testing."""
    with session_factory()() as db:
        start = end - timedelta(days=7)
        for i in range(slot_count):
            obs_time = start + timedelta(minutes=15 * i + 5)
            oid = f"OBS-SLOT-{farm_id}-{i:04d}"
            measurements = [
                {"type": "air_temperature", "value": 26.5, "unit": "C"},
                {"type": "soil_moisture_index", "value": 45.0, "unit": "percent"},
            ]
            if include_humidity:
                measurements.append({"type": "relative_humidity", "value": 72.0, "unit": "percent"})
            payload = {
                "observation_id": oid,
                "farm_id": farm_id,
                "crop_id": None,
                "device_id": "SYN-ESP32-01",
                "observed_at": obs_time.isoformat().replace("+00:00", "Z"),
                "recorded_at": obs_time.isoformat().replace("+00:00", "Z"),
                "source": "simulated_iot",
                "status": "RECORDED",
                "measurements": measurements,
            }
            save(db, "Observation", payload, id=oid, farm_id=farm_id, crop_id=None)
        db.commit()


def test_b01_sensor_backed_inference_538_vs_537_slots_and_no_manual_ids(tmp_path, monkeypatch):
    _setup_env(monkeypatch, tmp_path, model_enabled=True)
    monkeypatch.setattr(settings, "model_path", "ai/models/model.joblib")
    pred_at = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)

    with TestClient(app, headers={"host": "localhost"}) as client:
        coord = _login(client, "coordinator", "rem-coordinator-password-123")
        farmer = _login(client, "farmer", "rem-farmer-password-123456")

        # Wrong-period estimate rejected (422)
        wrong_est = client.post(
            "/api/v1/harvest-estimates",
            headers=farmer,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "harvest_period": "2026-W47",
                "estimated_quantity_kg": 10,
                "recorded_at": "2026-11-24T08:00:00Z",
            },
        )
        assert wrong_est.status_code == 201
        bad_ref = client.post(
            "/api/v1/harvest-predictions",
            headers=coord,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "target_period": "2026-W48",
                "data_reference_ids": [wrong_est.json()["estimate_id"]],
                "prediction_at": pred_at.isoformat(),
            },
        )
        assert bad_ref.status_code == 422
        assert bad_ref.json()["error"]["code"] == "ESTIMATE_PERIOD_MISMATCH"

        # 537 slots -> insufficient for 80% (538) threshold -> manual ML route
        _seed_sensor_slots(537, pred_at, include_humidity=True)
        res_537 = client.post(
            "/api/v1/harvest-predictions",
            headers=coord,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "target_period": "2026-W48",
                "prediction_at": pred_at.isoformat(),
            },
        )
        assert res_537.status_code == 201, res_537.text
        assert res_537.json()["inference_route"] == "manual"
        assert res_537.json()["input_snapshot"]["coverage"]["air_temperature"]["valid_slots"] == 537

        # Add 1 more distinct slot (538th) -> reaches 80% coverage -> full sensor-backed route with NO manual IDs!
        with session_factory()() as db:
            obs_time = pred_at - timedelta(minutes=10)
            save(
                db,
                "Observation",
                {
                    "observation_id": "OBS-SLOT-538",
                    "farm_id": "FARM-01",
                    "crop_id": None,
                    "device_id": "SYN-ESP32-01",
                    "observed_at": obs_time.isoformat().replace("+00:00", "Z"),
                    "recorded_at": obs_time.isoformat().replace("+00:00", "Z"),
                    "source": "simulated_iot",
                    "status": "RECORDED",
                    "measurements": [
                        {"type": "air_temperature", "value": 26.5, "unit": "C"},
                        {"type": "relative_humidity", "value": 72.0, "unit": "percent"},
                        {"type": "soil_moisture_index", "value": 45.0, "unit": "percent"},
                    ],
                },
                id="OBS-SLOT-538",
                farm_id="FARM-01",
            )
            db.commit()

        res_538 = client.post(
            "/api/v1/harvest-predictions",
            headers=coord,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "target_period": "2026-W48",
                "prediction_at": pred_at.isoformat(),
            },
        )
        assert res_538.status_code == 201, res_538.text
        body = res_538.json()
        assert body["inference_route"] == "full"
        assert body["input_snapshot"]["coverage"]["air_temperature"]["valid_slots"] == 538
        assert body["input_snapshot"]["observation_count"] == 538


def test_b02_b03_duplicate_selection_oversell_and_cross_member_privacy(tmp_path, monkeypatch):
    _setup_env(monkeypatch, tmp_path, model_enabled=False)

    with TestClient(app, headers={"host": "localhost"}) as client:
        farmer = _login(client, "farmer", "rem-farmer-password-123456")
        coord = _login(client, "coordinator", "rem-coordinator-password-123")
        member1 = _login(client, "member-eligible", "rem-eligible-password-1234")
        member2 = _login(client, "member-regular", "rem-regular-password-12345")

        est = client.post(
            "/api/v1/harvest-estimates",
            headers=farmer,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "harvest_period": "2026-W48",
                "estimated_quantity_kg": 1.0,
                "recorded_at": "2026-11-25T08:00:00Z",
            },
        )
        assert est.status_code == 201
        avl = client.post(
            "/api/v1/approved-availability",
            headers=coord,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "period": "2026-W48",
                "basis_type": "MANUAL_ESTIMATE",
                "basis_id": est.json()["estimate_id"],
                "approved_quantity_kg": 1.0,
                "approval_note": "manual fallback",
            },
        )
        assert avl.status_code == 201
        avl_id = avl.json()["availability_id"]

        # B02: Duplicate availability_id in one selection (0.75 + 0.75 > 1.0 kg) MUST be rejected
        dup_sel = client.post(
            "/api/v1/member-selections",
            headers=member1,
            json={
                "period": "2026-W48",
                "items": [
                    {"availability_id": avl_id, "availability_version": 1, "quantity_kg": 0.75},
                    {"availability_id": avl_id, "availability_version": 1, "quantity_kg": 0.75},
                ],
            },
        )
        assert dup_sel.status_code == 422
        assert dup_sel.json()["error"]["code"] == "DUPLICATE_AVAILABILITY_ITEM"

        # Coordinator adjusts allocation with MBR-001 and MBR-002
        adj = client.post(
            "/api/v1/allocation-adjustments",
            headers=coord,
            json={
                "availability_id": avl_id,
                "expected_version": 1,
                "approved_quantity_kg": 1.0,
                "reason": "assign demo allocations",
                "member_allocations": [
                    {"member_id": "MBR-001", "quantity_kg": 0.5},
                    {"member_id": "MBR-002", "quantity_kg": 0.5},
                ],
            },
        )
        assert adj.status_code == 201

        # B03: Member 2 reads API-06 — must NOT see MBR-001, member_allocations, allocation_changes, or approval_note
        m2_avail = client.get("/api/v1/approved-availability?period=2026-W48", headers=member2)
        assert m2_avail.status_code == 200
        raw_text = json.dumps(m2_avail.json())
        assert "MBR-001" not in raw_text
        assert "member_allocations" not in raw_text
        assert "allocation_changes" not in raw_text
        assert "approval_note" not in raw_text
        assert m2_avail.json()["items"][0]["own_allocation_kg"] == 0.5

        # Coordinator still sees operational details
        c_avail = client.get("/api/v1/approved-availability?period=2026-W48", headers=coord)
        assert c_avail.status_code == 200
        assert "member_allocations" in c_avail.json()["items"][0]

        # B05: Removing MBR-002 in a subsequent adjustment emits a zero-quantity/removed update on API-12 for MBR-002
        adj2 = client.post(
            "/api/v1/allocation-adjustments",
            headers=coord,
            json={
                "availability_id": avl_id,
                "expected_version": 2,
                "approved_quantity_kg": 0.5,
                "reason": "shortfall removal",
                "member_allocations": [{"member_id": "MBR-001", "quantity_kg": 0.5}],
            },
        )
        assert adj2.status_code == 201
        m2_updates = client.get("/api/v1/allocation-updates?period=2026-W48", headers=member2)
        assert m2_updates.status_code == 200
        latest_m2 = m2_updates.json()["items"][0]
        assert latest_m2["quantity_kg"] == 0.0
        assert latest_m2["removed"] is True
        assert "MBR-001" not in json.dumps(m2_updates.json())


def test_b04_b04a_b05_b06_b07_b08_workflow_and_validation(tmp_path, monkeypatch):
    _setup_env(monkeypatch, tmp_path, model_enabled=True)
    monkeypatch.setattr(settings, "model_path", "ai/models/model.joblib")

    with TestClient(app, headers={"host": "localhost"}) as client:
        coord = _login(client, "coordinator", "rem-coordinator-password-123")
        farmer = _login(client, "farmer", "rem-farmer-password-123456")
        member1 = _login(client, "member-eligible", "rem-eligible-password-1234")

        # B07: Impossible ISO week (2025 has only 52 weeks) on GET query returns 422 INVALID_PERIOD (not 500)
        bad_week = client.get("/api/v1/approved-availability?period=2025-W53", headers=coord)
        assert bad_week.status_code == 422
        assert bad_week.json()["error"]["code"] == "INVALID_PERIOD"

        # B06: Seeded demo does NOT pre-confirm receipt for MBR-001
        early_fb = client.post(
            "/api/v1/member-feedback",
            headers=member1,
            json={"period": "2026-W48", "comment": "should fail before receipt"},
        )
        assert early_fb.status_code == 409
        assert early_fb.json()["error"]["code"] == "PACKAGE_NOT_RECEIVED"

        # B08: Automated prediction scheduler generates prediction once and skips duplicate unchanged run
        sched = PredictionScheduler()
        sched.enqueue("FARM-01", "SPINACH", "2026-W48", trigger="scheduled")
        first_run = sched.run_pending()
        assert len(first_run) == 1
        pred1_id = first_run[0]["prediction_id"]
        pred1_qty = first_run[0]["predicted_quantity_kg"]

        sched.enqueue("FARM-01", "SPINACH", "2026-W48", trigger="scheduled")
        second_run = sched.run_pending()
        assert second_run[0]["prediction_id"] == pred1_id  # unchanged fingerprint reused

        # Farmer can read own-farm AI prediction; Member cannot
        assert client.get(f"/api/v1/harvest-predictions/{pred1_id}", headers=farmer).status_code == 200
        assert client.get(f"/api/v1/harvest-predictions/{pred1_id}", headers=member1).status_code == 403

        # B04: Approving prediction WITHOUT prior risk assessment or commodity plan fails with 422 REVIEW_REQUIRED
        unreviewed = client.post(
            "/api/v1/approved-availability",
            headers=coord,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "period": "2026-W48",
                "basis_type": "PREDICTION",
                "basis_id": pred1_id,
                "approved_quantity_kg": pred1_qty,
                "approval_note": "trying without review",
            },
        )
        assert unreviewed.status_code == 422
        assert unreviewed.json()["error"]["code"] == "REVIEW_REQUIRED"

        # B04a: Commodity plan aggregates supply against demand once
        plan = client.post(
            "/api/v1/commodity-plans",
            headers=coord,
            json={
                "crop_id": "SPINACH",
                "period": "2026-W48",
                "planned_demand_kg": pred1_qty + 4.0,
                "review_note": "reviewed with farmer",
                "verified_with_farmer": True,
            },
        )
        assert plan.status_code == 201, plan.text
        assert abs(plan.json()["shortage_gap_kg"] - 4.0) < 1e-4
        assert plan.json()["status"] == "SHORTAGE_POSSIBLE"

        # Now approval succeeds referencing the reviewed commodity plan
        approved = client.post(
            "/api/v1/approved-availability",
            headers=coord,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "period": "2026-W48",
                "basis_type": "PREDICTION",
                "basis_id": pred1_id,
                "approved_quantity_kg": pred1_qty,
                "approval_note": "approved from commodity plan",
                "commodity_plan_id": plan.json()["plan_id"],
            },
        )
        assert approved.status_code == 201, approved.text
        assert approved.json()["commodity_plan_id"] == plan.json()["plan_id"]

        # B05: Actual harvest outside Asia/Jakarta ISO week W48 (e.g. 2026-11-15 = W46) rejected
        bad_actual = client.post(
            "/api/v1/actual-harvests",
            headers=coord,
            json={
                "farm_id": "FARM-01",
                "crop_id": "SPINACH",
                "period": "2026-W48",
                "actual_quantity_kg": 5.0,
                "harvested_at": "2026-11-15T08:00:00Z",
                "source": "manual",
                "confirmation_note": "wrong week",
            },
        )
        assert bad_actual.status_code == 422
        assert bad_actual.json()["error"]["code"] == "HARVEST_DATE_OUT_OF_PERIOD"

        # Telemetry summary & history with no readings returns unknown & null (never 0)
        tsum = client.get("/api/v1/telemetry/summary?farm_id=FARM-01", headers=coord)
        assert tsum.status_code == 200
        assert tsum.json()["status"] == "unknown"
        assert tsum.json()["readings"]["relative_humidity"] is None

        thist = client.get("/api/v1/telemetry/history?farm_id=FARM-01&range=1h", headers=coord)
        assert thist.status_code == 200
        assert len(thist.json()["series"]) == 12
        assert thist.json()["series"][0]["relative_humidity"] is None

        # Role overview endpoints return 200 for respective roles
        coord_ov = client.get("/api/v1/coordinator/overview?period=2026-W48", headers=coord)
        assert coord_ov.status_code == 200
        assert len(coord_ov.json()["farms"]) >= 1
        assert len(coord_ov.json()["member_rows"]) >= 2
        assert client.get("/api/v1/farmer/overview?period=2026-W48", headers=farmer).status_code == 200
        assert client.get("/api/v1/member/overview?period=2026-W48", headers=member1).status_code == 200


def test_revision_seed_scenarios_receipt_gate_and_review_outcome(tmp_path, monkeypatch):
    from backend.app.seed import seed_scenario

    _setup_env(monkeypatch, tmp_path, model_enabled=True)
    monkeypatch.setattr(settings, "model_path", "ai/models/model.joblib")

    with TestClient(app, headers={"host": "localhost"}) as client:
        coord = _login(client, "coordinator", "rem-coordinator-password-123")
        member1 = _login(client, "member-eligible", "rem-eligible-password-1234")

        # Insert a live MQTT observation that must survive --reset-demo
        with session_factory()() as db:
            save(
                db,
                "Observation",
                {
                    "observation_id": "OBS-LIVE-IOT-KEEP",
                    "farm_id": "FARM-01",
                    "device_id": "BLOK-A1",
                    "observed_at": "2026-11-26T10:00:00Z",
                    "recorded_at": "2026-11-26T10:00:00Z",
                    "source": "iot",
                    "provenance": "mqtt_public_unverified",
                    "status": "RECORDED",
                    "measurements": [{"type": "air_temperature", "value": 27.3, "unit": "C"}],
                },
                id="OBS-LIVE-IOT-KEEP",
                farm_id="FARM-01",
            )
            seed_scenario(db, scenario="operational", period="2026-W48", reset_demo=True)
            # Run a second time to verify idempotency
            seed_scenario(db, scenario="operational", period="2026-W48", reset_demo=False)
            assert db.get(Record, "OBS-LIVE-IOT-KEEP") is not None
            db.commit()

        ov = client.get("/api/v1/coordinator/overview?period=2026-W48", headers=coord).json()
        assert len(ov["farms"]) == 2
        assert len(ov["plantings"]) == 6
        assert len(ov["member_rows"]) == 6
        assert ov["demo_mode"] is True
        assert "2026-W47" in ov["available_periods"]

        # MBR-001 has not selected yet in operational, and has no finalized allocation -> receipt blocked with 409 ALLOCATION_REQUIRED
        rcpt_blocked = client.post(
            "/api/v1/package-receipts",
            headers=coord,
            json={"member_id": "MBR-001", "period": "2026-W48", "confirmed": True},
        )
        assert rcpt_blocked.status_code == 409
        assert rcpt_blocked.json()["error"]["code"] == "ALLOCATION_REQUIRED"

        # MBR-001 sees all 6 approved availability items covering all 5 crops on member overview
        mov = client.get("/api/v1/member/overview?period=2026-W48", headers=member1).json()
        assert len(mov["availability"]) == 6
        assert len({a["crop_id"] for a in mov["availability"]}) == 5

        # Switch to walkthrough scenario safely and test WAITING_FARMER review gate
        with session_factory()() as db:
            seed_scenario(db, scenario="walkthrough", period="2026-W48", reset_demo=True)
            assert db.get(Record, "OBS-LIVE-IOT-KEEP") is not None
            db.commit()

        w_ov = client.get("/api/v1/coordinator/overview?period=2026-W48", headers=coord).json()
        assert len(w_ov["approvals"]) == 0
        spinach_pred = next(p["latest_prediction"] for p in w_ov["plantings"] if p["crop"]["crop_id"] == "SPINACH")

        waiting_plan = client.post(
            "/api/v1/commodity-plans",
            headers=coord,
            json={
                "crop_id": "SPINACH",
                "period": "2026-W48",
                "planned_demand_kg": 25.0,
                "review_outcome": "WAITING_FARMER",
                "farmer_verification_status": "WAITING",
                "review_note": "Menunggu konfirmasi Pak Dedi",
            },
        )
        assert waiting_plan.status_code == 201
        blocked_approve = client.post(
            "/api/v1/approved-availability",
            headers=coord,
            json={
                "farm_id": spinach_pred["farm_id"],
                "crop_id": "SPINACH",
                "period": "2026-W48",
                "basis_type": "PREDICTION",
                "basis_id": spinach_pred["prediction_id"],
                "approved_quantity_kg": spinach_pred["predicted_quantity_kg"],
                "approval_note": "Should be blocked while waiting farmer",
                "commodity_plan_id": waiting_plan.json()["plan_id"],
            },
        )
        assert blocked_approve.status_code == 422
        assert blocked_approve.json()["error"]["code"] == "VERIFICATION_PENDING"


def test_b09_farmer_farm_scope_isolation_and_member_packages(tmp_path, monkeypatch):
    from backend.app.seed import seed_scenario

    _setup_env(monkeypatch, tmp_path, model_enabled=True)
    monkeypatch.setattr(settings, "model_path", "ai/models/model.joblib")

    with TestClient(app, headers={"host": "localhost"}) as client:
        with session_factory()() as db:
            seed_scenario(db, scenario="operational", period="2026-W48", reset_demo=True)
            db.commit()

        farmer = _login(client, "farmer", "rem-farmer-password-123456")
        coord = _login(client, "coordinator", "rem-coordinator-password-123")
        member1 = _login(client, "member-eligible", "rem-eligible-password-1234")

        # Farmer only sees assigned FARM-01 in catalog & overview
        f_cat = client.get("/api/v1/catalog", headers=farmer).json()
        assert [f["farm_id"] for f in f_cat["farms"]] == ["FARM-01"]
        f_ov = client.get("/api/v1/farmer/overview?period=2026-W48", headers=farmer).json()
        assert [fg["farm"]["farm_id"] for fg in f_ov["farms"]] == ["FARM-01"]

        # Farmer is blocked (403) from reading or writing FARM-02
        assert client.get("/api/v1/telemetry/summary?farm_id=FARM-02", headers=farmer).status_code == 403
        assert client.get("/api/v1/telemetry/history?farm_id=FARM-02&range=24h", headers=farmer).status_code == 403
        assert client.get("/api/v1/farm-observations?farm_id=FARM-02", headers=farmer).status_code == 403
        assert client.post(
            "/api/v1/harvest-estimates",
            headers=farmer,
            json={
                "farm_id": "FARM-02",
                "crop_id": "SPINACH",
                "harvest_period": "2026-W48",
                "estimated_quantity_kg": 2.0,
                "recorded_at": "2026-11-26T08:00:00Z",
            },
        ).status_code == 403

        # Coordinator sees both FARM-01 and FARM-02
        c_cat = client.get("/api/v1/catalog", headers=coord).json()
        assert sorted(f["farm_id"] for f in c_cat["farms"]) == ["FARM-01", "FARM-02"]
        assert client.get("/api/v1/telemetry/summary?farm_id=FARM-02", headers=coord).status_code == 200

        # Member sees no farms in catalog, 403 on telemetry, and package-centric history including 2026-W47
        m_cat = client.get("/api/v1/catalog", headers=member1).json()
        assert m_cat["farms"] == []
        assert client.get("/api/v1/telemetry/summary?farm_id=FARM-01", headers=member1).status_code == 403
        m_ov = client.get("/api/v1/member/overview?period=2026-W48", headers=member1).json()
        assert any(pkg["period"] == "2026-W47" and pkg["receipt_confirmed"] and pkg["feedback"] for pkg in m_ov["packages"])


def test_v3_identities_offline_farm_and_next_period_subscription(tmp_path, monkeypatch):
    from backend.app.seed import seed_scenario

    _setup_env(monkeypatch, tmp_path, model_enabled=True)
    monkeypatch.setattr(settings, "model_path", "ai/models/model.joblib")

    with TestClient(app, headers={"host": "localhost"}) as client:
        with session_factory()() as db:
            seed_scenario(db, scenario="operational", period="2026-W48", reset_demo=True)
            db.commit()

        coord = _login(client, "coordinator", "rem-coordinator-password-123")
        member1 = _login(client, "member-eligible", "rem-eligible-password-1234")
        member2 = _login(client, "member-regular", "rem-regular-password-12345")

        # V3 names & offline Kebun Cimenyan
        c_ov = client.get("/api/v1/coordinator/overview?period=2026-W48", headers=coord).json()
        names = {m["member_id"]: m["name"] for m in c_ov["member_rows"]}
        assert names["MBR-001"] == "Nisrina Pratiwi"
        assert names["MBR-002"] == "Adrian Hidayat"
        farm2 = next(f for f in c_ov["farms"] if f["farm"]["farm_id"] == "FARM-02")
        assert farm2["telemetry"]["status"] == "offline"
        assert any(p["latest_prediction"] is not None for p in farm2["plantings"])

        # Next-period subscription switch preserves 2026-W48 and takes effect in 2026-W49
        sw1 = client.post(
            "/api/v1/member/subscription",
            headers=member1,
            json={"period": "2026-W48", "target_package": "Paket Reguler"},
        )
        assert sw1.status_code == 200
        assert sw1.json()["effective_period"] == "2026-W49"

        ov_w48 = client.get("/api/v1/member/overview?period=2026-W48", headers=member1).json()
        assert ov_w48["member"]["package_name"] == "Paket Custom"
        assert ov_w48["member"]["eligible"] is True
        assert ov_w48["next_period_subscription"]["package_name"] == "Paket Reguler"

        ov_w49 = client.get("/api/v1/member/overview?period=2026-W49", headers=member1).json()
        assert ov_w49["member"]["package_name"] == "Paket Reguler"
        assert ov_w49["member"]["eligible"] is False

        # Member 2 (Adrian Hidayat) can schedule Paket Custom for 2026-W49 while 2026-W48 stays Paket Reguler
        sw2 = client.post(
            "/api/v1/member/subscription",
            headers=member2,
            json={"period": "2026-W48", "target_package": "Paket Custom"},
        )
        assert sw2.status_code == 200
        ov2_w48 = client.get("/api/v1/member/overview?period=2026-W48", headers=member2).json()
        assert ov2_w48["member"]["package_name"] == "Paket Reguler"
        ov2_w49 = client.get("/api/v1/member/overview?period=2026-W49", headers=member2).json()
        assert ov2_w49["member"]["package_name"] == "Paket Custom"
        assert ov2_w49["member"]["eligible"] is True

