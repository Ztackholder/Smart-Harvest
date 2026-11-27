from __future__ import annotations
import argparse
import math
import random
from datetime import date, datetime, timedelta, timezone
from sqlalchemy import select
from sqlalchemy.orm import Session
from .core import Principal, Record, configure_database, init_db, list_records, record, save, session_factory
from .schemas import validate_period
from .services.svc_02_farm_record import FarmRecordService
from .services.svc_03_prediction import HarvestPredictionService
from .services.svc_04_supply import SupplyCoordinationService
from .services.svc_05_member import MemberInformationService

JAKARTA_TZ = timezone(timedelta(hours=7))

DEMO_FARMS = (
    {"farm_id": "FARM-01", "name": "Kebun Ciburial", "farmer_name": "Faiz Santoso", "contact_phone": None},
)

DEMO_CROPS = (
    {"crop_id": "SPINACH", "name": "Bayam", "supported_by_model": True},
    {"crop_id": "KANGKUNG", "name": "Kangkung", "supported_by_model": True},
    {"crop_id": "PAKCHOY", "name": "Pakcoy", "supported_by_model": True},
    {"crop_id": "LETTUCE", "name": "Selada hijau", "supported_by_model": True},
    {"crop_id": "MUSTARD_GREENS", "name": "Sawi hijau", "supported_by_model": True},
)

DEMO_MEMBERS = (
    ("MBR-001", "Nisrina Pratiwi", "Paket Custom", True, 2.0, 2.0),
    ("MBR-002", "Adrian Hidayat", "Paket Reguler", False, 0.0, 2.0),
)

DEMO_PLANTINGS = (
    ("PLANT-FARM01-SPINACH", "FARM-01", "SPINACH", 2.5, 20, 3.2),
    ("PLANT-FARM01-KANGKUNG", "FARM-01", "KANGKUNG", 2.5, 25, 3.5),
    ("PLANT-FARM01-PAKCHOY", "FARM-01", "PAKCHOY", 2.2, 18, 4.3),
    ("PLANT-FARM01-LETTUCE", "FARM-01", "LETTUCE", 2.0, 16, 2.8),
    ("PLANT-FARM01-MUSTARD", "FARM-01", "MUSTARD_GREENS", 2.5, 20, 3.8),
)


def _period_monday(period: str) -> date:
    validate_period(period)
    year, week = period.split("-W")
    return date.fromisocalendar(int(year), int(week), 1)


def _shift_period(period: str, weeks: int) -> str:
    target = _period_monday(period) + timedelta(days=weeks * 7)
    cal = target.isocalendar()
    return f"{cal.year}-W{cal.week:02d}"


def _upsert(db: Session, kind: str, rid: str, payload: dict, **cols) -> Record:
    existing = db.get(Record, rid)
    if existing:
        existing.payload = payload
        for k, v in cols.items():
            setattr(existing, k, v)
        db.flush()
        return existing
    return save(db, kind, payload, id=rid, **cols)


def reset_demo_records(db: Session) -> int:
    """Safely reset demo scenario records; never delete live MQTT iot observations or auth users/sessions."""
    resettable_kinds = {
        "HarvestEstimate",
        "HarvestPrediction",
        "PredictionState",
        "SupplyRiskAssessment",
        "CommodityPlan",
        "ApprovedAvailability",
        "AllocationAdjustment",
        "MemberSelection",
        "ActualHarvest",
        "Receipt",
        "MemberFeedback",
    }
    active_farms = {f["farm_id"] for f in DEMO_FARMS}
    active_members = {m[0] for m in DEMO_MEMBERS}
    active_plantings = {p[0] for p in DEMO_PLANTINGS}
    rows = db.scalars(select(Record)).all()
    deleted = 0
    stale_farms: list[Record] = []
    for row in rows:
        if row.kind == "Observation":
            if row.farm_id not in active_farms or row.payload.get("demo_scenario") or row.payload.get("demo_fixture"):
                if row.payload.get("source") == "iot" and row.farm_id in active_farms:
                    continue
                db.delete(row)
                deleted += 1
        elif row.kind in resettable_kinds:
            db.delete(row)
            deleted += 1
        elif row.kind == "Planting" and row.id not in active_plantings:
            db.delete(row)
            deleted += 1
        elif row.kind == "Device" and row.farm_id not in active_farms:
            db.delete(row)
            deleted += 1
        elif row.kind == "Member" and row.id not in active_members:
            db.delete(row)
            deleted += 1
        elif row.kind == "Farm" and row.id not in active_farms:
            stale_farms.append(row)
    db.flush()
    for farm_row in stale_farms:
        db.delete(farm_row)
        deleted += 1
    db.flush()
    return deleted


def _seed_telemetry_7d(db: Session, scenario: str, cutoff_utc: datetime) -> None:
    rng = random.Random(42)
    configs = (
        # FARM-01: Kebun Ciburial — stable (~26.4C, ~78% RH, ~65% soil), fresh
        ("FARM-01", "SYN-CIBURIAL-01", 26.4, 78.0, 65.0, 926.0, timedelta(minutes=5)),
    )
    for farm_id, dev_id, base_t, base_h, base_s, base_p, lag in configs:
        end_dt = cutoff_utc - lag
        start_dt = end_dt - timedelta(days=7) + timedelta(minutes=15)
        for slot in range(672):
            obs_dt = start_dt + timedelta(minutes=15 * slot)
            oid = f"OBS-DEMO-{farm_id}-{slot:04d}"
            if db.get(Record, oid):
                continue
            wave = math.sin(slot / 16.0)
            temp = round(base_t + 1.2 * wave + rng.uniform(-0.3, 0.3), 2)
            hum = round(min(100.0, max(0.0, base_h - 3.5 * wave + rng.uniform(-1.0, 1.0))), 2)
            soil = round(min(100.0, max(0.0, base_s + 2.5 * math.cos(slot / 24.0) + rng.uniform(-1.0, 1.0))), 1)
            pres = round(base_p + rng.uniform(-0.5, 0.5), 2)
            ts = obs_dt.isoformat().replace("+00:00", "Z")
            payload = {
                "observation_id": oid,
                "farm_id": farm_id,
                "crop_id": None,
                "device_id": dev_id,
                "observed_at": ts,
                "recorded_at": ts,
                "source": "simulated_iot",
                "provenance": "demo_fixture",
                "status": "RECORDED",
                "demo_scenario": scenario,
                "measurements": [
                    {"type": "air_temperature", "value": temp, "unit": "C"},
                    {"type": "relative_humidity", "value": hum, "unit": "percent"},
                    {"type": "soil_moisture_index", "value": soil, "unit": "percent"},
                    {"type": "pressure", "value": pres, "unit": "hPa"},
                ],
            }
            save(db, "Observation", payload, id=oid, farm_id=farm_id, crop_id=None)


def _seed_prior_completed_week(
    db: Session,
    farm_svc: FarmRecordService,
    pred_svc: HarvestPredictionService,
    supply_svc: SupplyCoordinationService,
    member_svc: MemberInformationService,
    coord: Principal,
    prev_period: str,
    scenario: str,
) -> None:
    if list_records(db, "ApprovedAvailability", period=prev_period):
        return
    prev_monday = _period_monday(prev_period)
    prev_ts = datetime.combine(prev_monday, datetime.min.time(), tzinfo=JAKARTA_TZ) + timedelta(hours=9)
    prev_harvest_ts = datetime.combine(prev_monday + timedelta(days=4), datetime.min.time(), tzinfo=JAKARTA_TZ) + timedelta(hours=10)

    # Seed representative Bayam & Kangkung completed cycle in prev_period
    for pid, fid, cid, area, count, est_qty in DEMO_PLANTINGS[:2]:
        est_id = f"EST-DEMO-{prev_period}-{fid}-{cid}"
        _upsert(
            db,
            "HarvestEstimate",
            est_id,
            {
                "estimate_id": est_id,
                "farm_id": fid,
                "crop_id": cid,
                "harvest_period": prev_period,
                "estimated_quantity_kg": est_qty,
                "recorded_at": prev_ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "status": "RECORDED",
                "reported_by": "USR-FARMER",
                "demo_scenario": scenario,
            },
            farm_id=fid,
            crop_id=cid,
            period=prev_period,
            owner_id="USR-FARMER",
        )
        pred_id = f"PRED-DEMO-{prev_period}-{fid}-{cid}"
        pred_qty = round(est_qty * 0.92, 2)
        _upsert(
            db,
            "HarvestPrediction",
            pred_id,
            {
                "prediction_id": pred_id,
                "farm_id": fid,
                "crop_id": cid,
                "planting_id": pid,
                "target_period": prev_period,
                "predicted_quantity_kg": pred_qty,
                "model_version": "rf-synthetic-v3",
                "source_of_training_data": "synthetic",
                "inference_route": "manual",
                "generated_at": prev_ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "status": "generated",
                "requires_coordinator_review": True,
                "demo_scenario": scenario,
            },
            farm_id=fid,
            crop_id=cid,
            period=prev_period,
        )
        risk = supply_svc.assess_risk({"prediction_id": pred_id, "planned_demand_kg": est_qty}, coord)
        avl = supply_svc.approve(
            {
                "farm_id": fid,
                "crop_id": cid,
                "period": prev_period,
                "basis_type": "PREDICTION",
                "basis_id": pred_id,
                "approved_quantity_kg": pred_qty,
                "approval_note": f"Persetujuan riwayat {prev_period}",
                "assessment_id": risk["assessment_id"],
            },
            coord,
        )
        actual_qty = round(pred_qty * 0.9, 2)
        actual = farm_svc.record_actual_harvest(
            {
                "farm_id": fid,
                "crop_id": cid,
                "period": prev_period,
                "actual_quantity_kg": actual_qty,
                "harvested_at": prev_harvest_ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "source": "coordinator-confirmed",
                "confirmation_note": f"Penimbangan aktual {prev_period}",
            },
            coord.user_id,
        )
        if cid == "SPINACH":
            supply_svc.adjust(
                {
                    "availability_id": avl["availability_id"],
                    "expected_version": 1,
                    "approved_quantity_kg": actual_qty,
                    "reason": "Penyesuaian sesuai hasil panen aktual minggu lalu",
                    "actual_harvest_id": actual["actual_harvest_id"],
                    "member_allocations": [
                        {"member_id": "MBR-001", "quantity_kg": 1.25},
                        {"member_id": "MBR-002", "quantity_kg": 1.25},
                    ],
                },
                coord,
            )

    for mid, name, pkg, elig, _, _ in DEMO_MEMBERS[:2]:
        m_principal = Principal(f"USR-{mid}", "MEMBER", name, [], mid, elig)
        if elig:
            avls = supply_svc.approved_availability(prev_period)
            if avls:
                member_svc.selection(
                    {
                        "period": prev_period,
                        "items": [{"availability_id": avls[0]["availability_id"], "availability_version": avls[0]["version"], "quantity_kg": 1.25}],
                    },
                    m_principal,
                )
        member_svc.receipt({"member_id": mid, "period": prev_period, "confirmed": True}, coord)
        member_svc.feedback(
            {
                "period": prev_period,
                "comment": "Sayuran segar dan sesuai jadwal panen." if elig else "Paket reguler diterima lengkap dan bersih.",
            },
            m_principal,
        )


def seed_scenario(db: Session, scenario: str = "operational", period: str = "2026-W48", reset_demo: bool = False) -> dict:
    validate_period(period)
    if reset_demo:
        reset_demo_records(db)

    farm_svc = FarmRecordService(db)
    pred_svc = HarvestPredictionService(db, farm_svc)
    supply_svc = SupplyCoordinationService(db, farm_record=farm_svc, prediction_service=pred_svc)
    member_svc = MemberInformationService(db, supply_svc, farm_record=farm_svc)
    coord = Principal("USR-COORD", "COORDINATOR", "Adriel Suherman", ["FARM-01", "FARM-02"])

    for f in DEMO_FARMS:
        _upsert(db, "Farm", f["farm_id"], {**f, "synthetic": True, "demo_scenario": scenario}, farm_id=f["farm_id"])
    for c in DEMO_CROPS:
        _upsert(db, "Crop", c["crop_id"], {**c, "demo_scenario": scenario}, crop_id=c["crop_id"])
    for dev_id, fid, trust in (
        ("BLOK-A1", "FARM-01", "public_mqtt_unverified"),
        ("SYN-CIBURIAL-01", "FARM-01", "local_simulator"),
    ):
        if not record(db, "Device", dev_id):
            save(db, "Device", {"device_id": dev_id, "farm_id": fid, "trust": trust}, id=dev_id, farm_id=fid)

    for mid, name, pkg, elig, quota, max_stock in DEMO_MEMBERS:
        _upsert(
            db,
            "Member",
            mid,
            {
                "member_id": mid,
                "name": name,
                "package_name": pkg,
                "eligible": elig,
                "quota_kg": quota,
                "max_stock_kg": max_stock,
                "synthetic": True,
                "demo_scenario": scenario,
            },
        )

    monday = _period_monday(period)
    target_date = (monday + timedelta(days=6)).isoformat()
    plant_date = (monday - timedelta(days=56)).isoformat()
    for pid, fid, cid, area, count, _ in DEMO_PLANTINGS:
        _upsert(
            db,
            "Planting",
            pid,
            {
                "planting_id": pid,
                "farm_id": fid,
                "crop_id": cid,
                "planting_date": plant_date,
                "target_harvest_date": target_date,
                "planted_area_m2": area,
                "plant_count": count,
                "synthetic": True,
                "demo_scenario": scenario,
            },
            farm_id=fid,
            crop_id=cid,
        )

    cutoff = datetime.combine(monday + timedelta(days=3), datetime.min.time(), tzinfo=JAKARTA_TZ) + timedelta(hours=12)
    now_utc = datetime.now(timezone.utc)
    if cutoff > now_utc:
        cutoff = now_utc
    _seed_telemetry_7d(db, scenario, cutoff)

    # Seed estimates & generate predictions (using real SVC-03 model if available, fallback fixture if disabled)
    pred_map: dict[tuple[str, str], dict] = {}
    for pid, fid, cid, _, _, est_qty in DEMO_PLANTINGS:
        est_id = f"EST-DEMO-{period}-{fid}-{cid}"
        if not db.get(Record, est_id):
            save(
                db,
                "HarvestEstimate",
                {
                    "estimate_id": est_id,
                    "farm_id": fid,
                    "crop_id": cid,
                    "harvest_period": period,
                    "estimated_quantity_kg": est_qty,
                    "recorded_at": (cutoff - timedelta(hours=2)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "status": "RECORDED",
                    "reported_by": "USR-FARMER",
                    "demo_scenario": scenario,
                },
                id=est_id,
                farm_id=fid,
                crop_id=cid,
                period=period,
                owner_id="USR-FARMER",
            )
        existing_pred = pred_svc.latest_for_scope(fid, cid, period)
        if existing_pred:
            pred_map[(fid, cid)] = existing_pred
        else:
            try:
                pred = pred_svc.generate(
                    {
                        "farm_id": fid,
                        "crop_id": cid,
                        "target_period": period,
                        "prediction_at": cutoff.astimezone(timezone.utc),
                        "planting_id": pid,
                    },
                    principal=coord,
                    trigger="seed",
                )
                pred_map[(fid, cid)] = pred
            except Exception:
                pass

    # Seed prior completed week (prev_period) for Riwayat & Evaluasi
    prev_period = _shift_period(period, -1)
    _seed_prior_completed_week(db, farm_svc, pred_svc, supply_svc, member_svc, coord, prev_period, scenario)

    if scenario == "operational":
        # Compute realistic commodity demand demonstrating shortages for SPINACH & PAKCHOY balanced for 6-member CSA
        demand_offset = {"SPINACH": 1.5, "PAKCHOY": 0.8, "KANGKUNG": -0.5, "LETTUCE": -0.3, "MUSTARD_GREENS": -0.4}
        by_crop: dict[str, list[dict]] = {}
        for (_, cid), pred in pred_map.items():
            by_crop.setdefault(cid, []).append(pred)

        for cid, preds in by_crop.items():
            supply_total = sum(p["predicted_quantity_kg"] for p in preds)
            demand = max(1.0, round(supply_total + demand_offset.get(cid, 0.0), 1))
            existing_plans = supply_svc.list_commodity_plans(period, crop_id=cid)
            if not existing_plans:
                plan = supply_svc.create_commodity_plan(
                    {
                        "crop_id": cid,
                        "period": period,
                        "planned_demand_kg": demand,
                        "review_note": (
                            "Perlu perhatian pasokan mingguan."
                            if demand > supply_total
                            else "Pasokan mencukupi kebutuhan mingguan."
                        ),
                        "verified_with_farmer": True,
                        "review_outcome": "CONFIRMED",
                        "farmer_verification_status": "CONFIRMED",
                    },
                    coord,
                )
            else:
                plan = existing_plans[0]

            for pred in preds:
                fid = pred["farm_id"]
                if not list_records(db, "ApprovedAvailability", farm_id=fid, crop_id=cid, period=period):
                    supply_svc.approve(
                        {
                            "farm_id": fid,
                            "crop_id": cid,
                            "period": period,
                            "basis_type": "PREDICTION",
                            "basis_id": pred["prediction_id"],
                            "approved_quantity_kg": pred["predicted_quantity_kg"],
                            "approval_note": "Penawaran dibuka untuk distribusi mingguan",
                            "commodity_plan_id": plan["plan_id"],
                        },
                        coord,
                    )

        # Assign regular package allocation to MBR-002 (Adrian Hidayat: 2.0 kg), leaving MBR-001 (Nisrina Pratiwi) interactive
        avls = supply_svc.approved_availability(period)
        if avls and not list_records(db, "AllocationAdjustment", period=period):
            supply_svc.adjust(
                {
                    "availability_id": avls[0]["availability_id"],
                    "expected_version": avls[0]["version"],
                    "approved_quantity_kg": avls[0]["approved_quantity_kg"],
                    "reason": "Rencana pembagian awal Paket Reguler",
                    "member_allocations": [{"member_id": "MBR-002", "quantity_kg": 1.0}],
                },
                coord,
            )
            if len(avls) > 1:
                supply_svc.adjust(
                    {
                        "availability_id": avls[1]["availability_id"],
                        "expected_version": avls[1]["version"],
                        "approved_quantity_kg": avls[1]["approved_quantity_kg"],
                        "reason": "Rencana pembagian awal Paket Reguler",
                        "member_allocations": [{"member_id": "MBR-002", "quantity_kg": 1.0}],
                    },
                    coord,
                )

    return {"scenario": scenario, "period": period, "farms": len(DEMO_FARMS), "plantings": len(DEMO_PLANTINGS), "members": len(DEMO_MEMBERS)}


def main():
    parser = argparse.ArgumentParser(description="SmartHarvest demo & baseline seed CLI")
    parser.add_argument("--scenario", choices=["operational", "walkthrough"], default=None)
    parser.add_argument("--period", default="2026-W48")
    parser.add_argument("--reset-demo", action="store_true")
    args = parser.parse_args()

    configure_database()
    init_db()
    s = session_factory()()
    try:
        if args.scenario is None:
            FarmRecordService(s).seed()
        else:
            res = seed_scenario(s, scenario=args.scenario, period=args.period, reset_demo=args.reset_demo)
            print(f"Seeded scenario={res['scenario']} period={res['period']} farms={res['farms']} plantings={res['plantings']} members={res['members']}")
        s.commit()
    finally:
        s.close()


if __name__ == "__main__":
    main()
