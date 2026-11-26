from __future__ import annotations
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..core import Record, error, list_records, record, save
from .common import audit, new_id, parse_period

JAKARTA_TZ = timezone(timedelta(hours=7))


def _parse_dt(raw: str | datetime) -> datetime:
    if isinstance(raw, datetime):
        dt = raw
    else:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class FarmRecordService:
    def __init__(self, session: Session):
        self.db = session

    def persist_observation(self, payload: dict) -> dict:
        rid = payload["observation_id"]
        if record(self.db, "Observation", rid):
            error("DUPLICATE_OBSERVATION", "Observation was already recorded", 409)
        save(self.db, "Observation", payload, id=rid, farm_id=payload["farm_id"], crop_id=payload.get("crop_id"))
        return payload

    def persist_estimate(self, payload: dict) -> dict:
        save(
            self.db,
            "HarvestEstimate",
            payload,
            id=payload["estimate_id"],
            farm_id=payload["farm_id"],
            crop_id=payload["crop_id"],
            period=payload["harvest_period"],
            owner_id=payload["reported_by"],
        )
        return payload

    def get_crop_context(self, farm_id: str, crop_id: str, planting_id: str | None = None) -> dict:
        if planting_id:
            row = record(self.db, "Planting", planting_id)
            if row is None or row.farm_id != farm_id or row.crop_id != crop_id:
                error("CONTEXT_NOT_FOUND", "Specified planting context was not found for farm and crop", 404)
            return {**row.payload, "planting_id": row.id}
        rows = list_records(self.db, "Planting", farm_id=farm_id, crop_id=crop_id)
        if not rows:
            error("CONTEXT_NOT_FOUND", "No planting context exists for farm and crop", 404)
        if len(rows) > 1:
            error("AMBIGUOUS_PLANTING", "Multiple active plantings require a planting_id selector", 422)
        return {**rows[0].payload, "planting_id": rows[0].id}

    def list_active_plantings(self, farm_id: str | None = None, crop_id: str | None = None) -> list[dict]:
        rows = list_records(self.db, "Planting", farm_id=farm_id, crop_id=crop_id)
        return [{**r.payload, "planting_id": r.id} for r in rows]

    def list_observations_in_window(
        self, farm_id: str, crop_id: str | None, window_start: datetime, window_end: datetime
    ) -> list[dict]:
        start_utc = _parse_dt(window_start)
        end_utc = _parse_dt(window_end)
        query = (
            select(Record)
            .where(Record.kind == "Observation", Record.farm_id == farm_id)
            .order_by(Record.created_at.desc())
        )
        if crop_id:
            query = query.where((Record.crop_id.is_(None)) | (Record.crop_id == crop_id))
        rows = self.db.scalars(query).all()
        matched: list[dict] = []
        for row in rows:
            obs_at = row.payload.get("observed_at")
            if not obs_at:
                continue
            try:
                dt = _parse_dt(obs_at)
            except ValueError:
                continue
            if start_utc <= dt < end_utc:
                matched.append(row.payload)
        return matched

    def list_observations_paginated(
        self,
        farm_id: str,
        crop_id: str | None = None,
        source: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        query = select(Record).where(Record.kind == "Observation", Record.farm_id == farm_id)
        if crop_id:
            query = query.where((Record.crop_id.is_(None)) | (Record.crop_id == crop_id))
        rows = self.db.scalars(query.order_by(Record.created_at.desc())).all()
        items = [r.payload for r in rows if not source or r.payload.get("source") == source]
        return items[offset : offset + limit]

    def get_observation(self, observation_id: str) -> dict | None:
        row = record(self.db, "Observation", observation_id)
        return row.payload if row else None

    def get_estimate(self, estimate_id: str) -> dict | None:
        row = record(self.db, "HarvestEstimate", estimate_id)
        return row.payload if row else None

    def list_estimates(
        self, farm_id: str | None = None, crop_id: str | None = None, period: str | None = None
    ) -> list[dict]:
        return [r.payload for r in list_records(self.db, "HarvestEstimate", farm_id=farm_id, crop_id=crop_id, period=period)]

    def get_harvest_record(self, farm_id: str, crop_id: str, period: str) -> list[dict]:
        return [r.payload for r in list_records(self.db, "ActualHarvest", farm_id=farm_id, crop_id=crop_id, period=period)]

    def get_actual_by_id(self, actual_harvest_id: str) -> dict | None:
        row = record(self.db, "ActualHarvest", actual_harvest_id)
        return row.payload if row else None

    def record_actual_harvest(self, payload: dict, actor_id: str) -> dict:
        parse_period(payload["period"])
        harvested_utc = _parse_dt(payload["harvested_at"])
        now_utc = datetime.now(timezone.utc)
        source = str(payload.get("source", ""))
        if harvested_utc > now_utc + timedelta(minutes=5) and not source.startswith("simulated"):
            error("FUTURE_HARVEST_TIMESTAMP", "Actual harvest timestamp cannot be in the future", 422)
        local_dt = harvested_utc.astimezone(JAKARTA_TZ)
        iso_cal = local_dt.isocalendar()
        actual_period = f"{iso_cal.year}-W{iso_cal.week:02d}"
        if actual_period != payload["period"]:
            error(
                "HARVEST_DATE_OUT_OF_PERIOD",
                f"harvested_at ({actual_period} Asia/Jakarta) does not match declared period {payload['period']}",
                422,
            )
        if self.get_harvest_record(payload["farm_id"], payload["crop_id"], payload["period"]):
            error("ACTUAL_HARVEST_EXISTS", "Actual harvest is already confirmed for this farm, crop and period", 409)
        rid = new_id("ACT")
        value = {
            **payload,
            "actual_harvest_id": rid,
            "status": "CONFIRMED",
            "confirmed_by": actor_id,
            "recorded_at": now_utc.isoformat().replace("+00:00", "Z"),
        }
        save(
            self.db,
            "ActualHarvest",
            value,
            id=rid,
            farm_id=value["farm_id"],
            crop_id=value["crop_id"],
            period=value["period"],
            owner_id=actor_id,
        )
        audit(self.db, actor_id, "recordActualHarvest", rid)
        return value

    def get_member(self, member_id: str) -> dict | None:
        row = record(self.db, "Member", member_id)
        return row.payload if row else None

    def list_members(self) -> list[dict]:
        return [r.payload for r in list_records(self.db, "Member")]

    def list_farms(self) -> list[dict]:
        return [r.payload for r in list_records(self.db, "Farm")]

    def list_crops(self) -> list[dict]:
        return [r.payload for r in list_records(self.db, "Crop")]

    def seed(self):
        if not list_records(self.db, "Farm", farm_id="FARM-01"):
            save(
                self.db,
                "Farm",
                {"farm_id": "FARM-01", "name": "Kebun Demo", "synthetic": True},
                id="FARM-01",
                farm_id="FARM-01",
            )
        if not list_records(self.db, "Crop", crop_id="SPINACH"):
            save(
                self.db,
                "Crop",
                {"crop_id": "SPINACH", "name": "Bayam", "supported_by_model": True},
                id="SPINACH",
                crop_id="SPINACH",
            )
        if not list_records(self.db, "Planting", farm_id="FARM-01", crop_id="SPINACH"):
            save(
                self.db,
                "Planting",
                {
                    "farm_id": "FARM-01",
                    "crop_id": "SPINACH",
                    "planting_date": "2026-10-01",
                    "target_harvest_date": "2026-11-27",
                    "planted_area_m2": 8.0,
                    "plant_count": 64,
                    "synthetic": True,
                },
                id="PLANT-FARM01-SPINACH",
                farm_id="FARM-01",
                crop_id="SPINACH",
            )
        if not record(self.db, "Device", "BLOK-A1"):
            save(
                self.db,
                "Device",
                {"device_id": "BLOK-A1", "farm_id": "FARM-01", "trust": "public_mqtt_unverified"},
                id="BLOK-A1",
                farm_id="FARM-01",
            )
        if not record(self.db, "Device", "SYN-ESP32-01"):
            save(
                self.db,
                "Device",
                {"device_id": "SYN-ESP32-01", "farm_id": "FARM-01", "trust": "local_simulator"},
                id="SYN-ESP32-01",
                farm_id="FARM-01",
            )
        member_specs = (
            ("MBR-001", "Anggota 1", "Paket Pilih", True, 2.0, 2.0),
            ("MBR-002", "Anggota 2", "Paket Reguler", False, 0.0, 2.0),
        )
        for member_id, name, package_name, eligible, quota_kg, max_stock_kg in member_specs:
            if not record(self.db, "Member", member_id):
                save(
                    self.db,
                    "Member",
                    {
                        "member_id": member_id,
                        "name": name,
                        "package_name": package_name,
                        "eligible": eligible,
                        "quota_kg": quota_kg,
                        "max_stock_kg": max_stock_kg,
                        "synthetic": True,
                    },
                    id=member_id,
                )
        # B06: Do not pre-confirm Receipt in normal demo seed; coordinator confirms receipt explicitly.
