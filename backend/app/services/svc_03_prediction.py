from __future__ import annotations
import hashlib
import json
import sys
import warnings
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from sqlalchemy.orm import Session
from ..core import Principal, error, list_records, record, save, settings, verify_scope
from ..sensor_aggregation import WINDOW, aggregate_observations
from .common import audit, new_id, parse_period

_MODEL_CACHE: dict[tuple[bool, str], tuple[object | None, str | None]] = {}


def load_predictor():
    key = (settings.model_enabled, settings.model_path)
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]
    if not settings.model_enabled:
        return (None, "disabled")
    try:
        root = str(Path.cwd())
        if root not in sys.path:
            sys.path.insert(0, root)
        from ai.src.predict import HarvestPredictor

        path = Path(settings.model_path)
        if not path.is_absolute():
            path = Path(root) / path
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            predictor = HarvestPredictor(path)
        mismatch = any("InconsistentVersionWarning" in str(item.message) for item in caught)
        result = (None, "scikit-learn artifact/runtime mismatch") if mismatch else (predictor, None)
    except Exception as exc:
        result = (None, type(exc).__name__)
    _MODEL_CACHE[key] = result
    return result


def _state_id(farm_id: str, crop_id: str, period: str, planting_id: str | None = None) -> str:
    suffix = f":{planting_id}" if planting_id else ""
    return f"PSTATE:{farm_id}:{crop_id}:{period}{suffix}"[:80]


def _input_fingerprint(planting_id: str, model_version: str, route: str, features: dict, estimate_ids: list[str]) -> str:
    canonical = {
        "planting_id": planting_id,
        "model_version": model_version,
        "route": route,
        "features": {k: round(v, 4) if isinstance(v, float) else v for k, v in sorted(features.items())},
        "estimate_ids": sorted(estimate_ids),
    }
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]


class HarvestPredictionService:
    def __init__(self, session: Session, farm_record, predictor=None):
        self.db = session
        self.farm_record = farm_record
        if predictor is not None:
            self.predictor, self.model_error = predictor, None
        else:
            self.predictor, self.model_error = load_predictor()

    def _upsert_state(self, farm_id: str, crop_id: str, period: str, state_payload: dict) -> dict:
        sid = _state_id(farm_id, crop_id, period)
        existing = record(self.db, "PredictionState", sid)
        if existing:
            existing.payload = {**existing.payload, **state_payload}
            self.db.flush()
            return existing.payload
        save(self.db, "PredictionState", state_payload, id=sid, farm_id=farm_id, crop_id=crop_id, period=period)
        return state_payload

    def get_state(self, farm_id: str, crop_id: str, period: str) -> dict | None:
        row = record(self.db, "PredictionState", _state_id(farm_id, crop_id, period))
        return row.payload if row else None

    def mark_stale(self, farm_id: str, crop_id: str, period: str, reason: str) -> dict | None:
        existing = self.get_state(farm_id, crop_id, period)
        if not existing:
            return None
        return self._upsert_state(
            farm_id,
            crop_id,
            period,
            {
                "status": "stale",
                "stale_reason": reason,
                "stale_marked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
        )

    def generate(
        self,
        data: dict,
        principal: Principal | None = None,
        *,
        trigger: str = "manual",
        skip_if_unchanged: bool = False,
    ) -> dict:
        if principal is not None:
            verify_scope(principal, data["farm_id"])
        parse_period(data["target_period"])
        context = self.farm_record.get_crop_context(
            data["farm_id"], data["crop_id"], planting_id=data.get("planting_id")
        )
        target = date.fromisoformat(context["target_harvest_date"]).isocalendar()
        context_period = f"{target.year}-W{target.week:02d}"
        if context_period != data["target_period"]:
            error(
                "TARGET_PERIOD_MISMATCH",
                "Prediction period must match the planting target harvest date",
                422,
            )

        now = data.get("prediction_at")
        if now is None:
            now = datetime.now(timezone.utc)
        elif isinstance(now, str):
            now = datetime.fromisoformat(now.replace("Z", "+00:00")).astimezone(timezone.utc)
        else:
            now = now.astimezone(timezone.utc)

        # Validate any explicitly passed data_reference_ids (backwards-compatible with D2 API-03)
        explicit_obs: list[dict] = []
        estimate_ref_ids: list[str] = []
        for rid in data.get("data_reference_ids") or []:
            obs = self.farm_record.get_observation(rid)
            if obs is not None:
                if obs["farm_id"] != data["farm_id"] or (obs.get("crop_id") and obs["crop_id"] != data["crop_id"]):
                    error("REFERENCE_SCOPE_MISMATCH", "Observation reference does not match farm and crop", 422)
                explicit_obs.append(obs)
                continue
            est = self.farm_record.get_estimate(rid)
            if est is not None:
                if est["farm_id"] != data["farm_id"] or est["crop_id"] != data["crop_id"]:
                    error("REFERENCE_SCOPE_MISMATCH", "Estimate reference does not match farm and crop", 422)
                if est["harvest_period"] != data["target_period"]:
                    error("ESTIMATE_PERIOD_MISMATCH", "Estimate reference period does not match target_period", 422)
                estimate_ref_ids.append(rid)
                continue
            error("REFERENCE_NOT_FOUND", "A data reference does not exist", 404)

        # B01: Always resolve 7-day scoped sensor history server-side via SVC-02 (not limited to 100 IDs)
        window_start = now - WINDOW
        window_obs = self.farm_record.list_observations_in_window(
            data["farm_id"], data["crop_id"], window_start, now
        )
        obs_by_id: dict[str, dict] = {o["observation_id"]: o for o in window_obs}
        for o in explicit_obs:
            obs_by_id.setdefault(o["observation_id"], o)
        all_obs = list(obs_by_id.values())

        aggregate = aggregate_observations(all_obs, now)
        sensor_features = aggregate["features"]
        sensor_quality = aggregate["sensor_quality"]
        channel_quality = aggregate["quality"]

        missing_features = [
            k
            for k in ("air_temp_mean_7d_c", "humidity_mean_7d_pct", "soil_moisture_mean_7d_pct")
            if k not in sensor_features
        ]
        sources = sorted({o.get("source", "unknown") for o in all_obs})
        input_snapshot = {
            "planting_id": context.get("planting_id"),
            "window_start": aggregate["window_start"],
            "window_end": aggregate["window_end"],
            "observation_count": len(all_obs),
            "estimate_reference_ids": estimate_ref_ids,
            "sources": sources,
            "missing_features": missing_features,
            "coverage": {
                "air_temperature": {
                    "valid_slots": channel_quality["air_temperature_c"]["valid_slots"],
                    "expected_slots": channel_quality["air_temperature_c"]["expected_slots"],
                    "coverage": channel_quality["air_temperature_c"]["coverage"],
                    "last_seen_hours": channel_quality["air_temperature_c"]["last_seen_hours"],
                    "usable": channel_quality["air_temperature_c"]["usable"],
                },
                "relative_humidity": {
                    "valid_slots": channel_quality["relative_humidity_pct"]["valid_slots"],
                    "expected_slots": channel_quality["relative_humidity_pct"]["expected_slots"],
                    "coverage": channel_quality["relative_humidity_pct"]["coverage"],
                    "last_seen_hours": channel_quality["relative_humidity_pct"]["last_seen_hours"],
                    "usable": channel_quality["relative_humidity_pct"]["usable"],
                },
                "soil_moisture": {
                    "valid_slots": channel_quality["soil_moisture_index_pct"]["valid_slots"],
                    "expected_slots": channel_quality["soil_moisture_index_pct"]["expected_slots"],
                    "coverage": channel_quality["soil_moisture_index_pct"]["coverage"],
                    "last_seen_hours": channel_quality["soil_moisture_index_pct"]["last_seen_hours"],
                    "usable": channel_quality["soil_moisture_index_pct"]["usable"],
                },
            },
        }

        attempt_at = now.isoformat().replace("+00:00", "Z")
        if self.predictor is None:
            prev_state = self.get_state(data["farm_id"], data["crop_id"], data["target_period"])
            self._upsert_state(
                data["farm_id"],
                data["crop_id"],
                data["target_period"],
                {
                    "farm_id": data["farm_id"],
                    "crop_id": data["crop_id"],
                    "period": data["target_period"],
                    "status": "stale" if prev_state and prev_state.get("latest_prediction_id") else "unavailable",
                    "reason": self.model_error or "model_unavailable",
                    "last_attempt_at": attempt_at,
                    "input_snapshot": input_snapshot,
                },
            )
            error(
                "PREDICTION_UNAVAILABLE",
                "The configured model is missing, incompatible or disabled; use a matching farmer estimate",
                503,
            )

        features = {**context, "prediction_at": now.isoformat(), "sensor_quality": sensor_quality, **sensor_features}
        result = self.predictor.predict(features)
        if result.get("status") != "PREDICTED" or result.get("predicted_quantity_kg") is None:
            prev_state = self.get_state(data["farm_id"], data["crop_id"], data["target_period"])
            reason = (result.get("error") or {}).get("code", "inference_unavailable")
            self._upsert_state(
                data["farm_id"],
                data["crop_id"],
                data["target_period"],
                {
                    "farm_id": data["farm_id"],
                    "crop_id": data["crop_id"],
                    "period": data["target_period"],
                    "status": "stale" if prev_state and prev_state.get("latest_prediction_id") else "unavailable",
                    "reason": reason,
                    "last_attempt_at": attempt_at,
                    "input_snapshot": input_snapshot,
                },
            )
            error(
                "PREDICTION_UNAVAILABLE",
                "Model could not produce a prediction; use a matching farmer estimate",
                503,
            )

        route = result.get("inference_route", "manual")
        fp = _input_fingerprint(
            str(context.get("planting_id", "")),
            str(result["model_version"]),
            route,
            sensor_features,
            estimate_ref_ids,
        )
        prev_state = self.get_state(data["farm_id"], data["crop_id"], data["target_period"])
        if (
            skip_if_unchanged
            and prev_state
            and prev_state.get("status") == "ready"
            and prev_state.get("fingerprint") == fp
            and prev_state.get("latest_prediction_id")
        ):
            existing = self.get_by_id(prev_state["latest_prediction_id"])
            if existing is not None:
                self._upsert_state(
                    data["farm_id"],
                    data["crop_id"],
                    data["target_period"],
                    {"last_attempt_at": attempt_at, "input_snapshot": input_snapshot},
                )
                return existing

        payload = {
            "prediction_id": new_id("PRED"),
            "farm_id": data["farm_id"],
            "crop_id": data["crop_id"],
            "planting_id": context.get("planting_id"),
            "target_period": data["target_period"],
            "data_reference_ids": list(data.get("data_reference_ids") or []),
            "predicted_quantity_kg": round(float(result["predicted_quantity_kg"]), 4),
            "model_version": result["model_version"],
            "source_of_training_data": "synthetic"
            if result.get("training_provenance", {}).get("synthetic")
            else "historical",
            "training_provenance": result.get("training_provenance", {}),
            "inference_route": route,
            "feature_provenance": sources,
            "input_snapshot": input_snapshot,
            "trigger": trigger,
            "generated_at": attempt_at,
            "status": "generated",
            "requires_coordinator_review": True,
        }
        save(
            self.db,
            "HarvestPrediction",
            payload,
            id=payload["prediction_id"],
            farm_id=payload["farm_id"],
            crop_id=payload["crop_id"],
            period=payload["target_period"],
        )
        self._upsert_state(
            data["farm_id"],
            data["crop_id"],
            data["target_period"],
            {
                "farm_id": data["farm_id"],
                "crop_id": data["crop_id"],
                "period": data["target_period"],
                "planting_id": context.get("planting_id"),
                "status": "ready",
                "reason": None,
                "stale_reason": None,
                "latest_prediction_id": payload["prediction_id"],
                "predicted_quantity_kg": payload["predicted_quantity_kg"],
                "inference_route": route,
                "model_version": payload["model_version"],
                "fingerprint": fp,
                "last_attempt_at": attempt_at,
                "last_success_at": attempt_at,
                "input_snapshot": input_snapshot,
            },
        )
        actor = principal.user_id if principal else "SYSTEM-SCHEDULER"
        audit(self.db, actor, "generateHarvestPrediction", payload["prediction_id"], {"route": route, "trigger": trigger})
        return payload

    def get(self, prediction_id: str, principal: Principal) -> dict:
        row = record(self.db, "HarvestPrediction", prediction_id)
        if row is None:
            error("NOT_FOUND", "Prediction was not found", 404)
        verify_scope(principal, row.farm_id)
        return row.payload

    def get_by_id(self, prediction_id: str) -> dict | None:
        row = record(self.db, "HarvestPrediction", prediction_id)
        return row.payload if row else None

    def latest_for_scope(self, farm_id: str, crop_id: str, period: str) -> dict | None:
        rows = list_records(self.db, "HarvestPrediction", farm_id=farm_id, crop_id=crop_id, period=period, limit=1)
        return rows[0].payload if rows else None

    def list_for_scope(
        self, farm_id: str | None = None, crop_id: str | None = None, period: str | None = None
    ) -> list[dict]:
        return [
            r.payload
            for r in list_records(self.db, "HarvestPrediction", farm_id=farm_id, crop_id=crop_id, period=period)
        ]
