"""Backend-ready inference for the SmartHarvest SVC-03 model bundle."""

from __future__ import annotations

import math
import numbers
from collections.abc import Mapping
from pathlib import Path

import joblib
import pandas as pd

from .features import (
    AIR_FEATURES,
    FEATURE_ALLOWLISTS,
    SOIL_FEATURES,
    SUPPORTED_CROPS,
    parse_prediction_dates,
    select_route,
)


REQUIRED_INPUTS = (
    "crop_id",
    "planting_date",
    "prediction_at",
    "target_harvest_date",
    "planted_area_m2",
    "plant_count",
)


def _numeric_input(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


class HarvestPredictor:
    """Load once and predict non-negative total harvest kg for one planting."""

    def __init__(self, model_path: str | Path):
        path = Path(model_path).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.is_file():
            raise FileNotFoundError(f"Harvest model artifact not found: {path}")

        # Only load artifacts generated and trusted by the local training pipeline.
        bundle = joblib.load(path)
        if not isinstance(bundle, dict) or bundle.get("artifact_schema") != 1:
            raise ValueError("Unsupported SmartHarvest model artifact")
        routes = bundle.get("routes")
        if not isinstance(routes, dict) or set(routes) != set(FEATURE_ALLOWLISTS):
            raise ValueError("Model artifact does not contain all required routes")
        for route, feature_names in FEATURE_ALLOWLISTS.items():
            model_entry = routes.get(route)
            if (
                not isinstance(model_entry, dict)
                or tuple(model_entry.get("features", ())) != tuple(feature_names)
                or not hasattr(model_entry.get("pipeline"), "predict")
            ):
                raise ValueError(f"Model artifact has an invalid {route} route")
            estimator = getattr(
                model_entry["pipeline"], "named_steps", {}
            ).get("regressor")
            if hasattr(estimator, "n_jobs"):
                # Predictions arrive one planting at a time in the backend. Avoid
                # starting a worker pool for every single-row forest prediction.
                estimator.n_jobs = 1

        self._routes = routes
        self.model_version = str(bundle.get("model_version", "unknown"))
        self.training_provenance = bundle.get(
            "training_provenance",
            {"dataset": "unknown", "dataset_version": "unknown", "synthetic": True},
        )

    def _unavailable(
        self, code: str, message: str, fields: list[str] | None = None
    ) -> dict[str, object]:
        error: dict[str, object] = {"code": code, "message": message}
        if fields:
            error["fields"] = fields
        return {
            "status": "PREDICTION_UNAVAILABLE",
            "predicted_quantity_kg": None,
            "model_version": self.model_version,
            "inference_route": "unavailable",
            "training_provenance": self.training_provenance,
            "error": error,
        }

    def predict(self, input_data: Mapping[str, object]) -> dict[str, object]:
        """Predict one planting. Sensor quality failures select a lower route."""
        if not isinstance(input_data, Mapping):
            return self._unavailable(
                "INVALID_INPUT", "input_data must be a mapping"
            )

        missing = sorted(name for name in REQUIRED_INPUTS if name not in input_data)
        if missing:
            return self._unavailable(
                "MISSING_REQUIRED_INPUTS",
                "Mandatory prediction fields are missing",
                missing,
            )

        crop_value = input_data.get("crop_id")
        crop_id = crop_value.strip().upper() if isinstance(crop_value, str) else ""
        if crop_id not in SUPPORTED_CROPS:
            return self._unavailable(
                "UNSUPPORTED_CROP", "crop_id is not supported", ["crop_id"]
            )

        try:
            crop_age_days, days_until_target = parse_prediction_dates(
                input_data["planting_date"],
                input_data["prediction_at"],
                input_data["target_harvest_date"],
            )
        except (TypeError, ValueError, OverflowError) as exc:
            return self._unavailable("INVALID_DATES", str(exc))

        area = _numeric_input(input_data.get("planted_area_m2"))
        count = _numeric_input(input_data.get("plant_count"))
        invalid_numbers = []
        if area is None or area <= 0:
            invalid_numbers.append("planted_area_m2")
        if count is None or count <= 0 or (count is not None and not count.is_integer()):
            invalid_numbers.append("plant_count")
        if invalid_numbers:
            return self._unavailable(
                "INVALID_NUMERIC_INPUT",
                "Planting area and count must be finite positive values; plant_count must be an integer",
                invalid_numbers,
            )

        sensor_values = {
            name: _numeric_input(input_data.get(name))
            for name in AIR_FEATURES + SOIL_FEATURES
        }
        quality = input_data.get("sensor_quality")
        if quality is None:
            quality = input_data.get("quality_metadata")
        if quality is None:
            # Accept a flattened v3 sidecar as well as the documented nested object.
            quality_keys = {
                "air_source",
                "soil_source",
                "temperature_valid_slots",
                "humidity_valid_slots",
                "soil_valid_slots",
                "air_last_seen_hours",
                "soil_last_seen_hours",
                "expected_window_slots",
                "status",
            }
            flat_quality = {key: input_data[key] for key in quality_keys if key in input_data}
            quality = flat_quality if flat_quality else None

        route = select_route(sensor_values, quality)
        feature_values = {
            "crop_id": crop_id,
            "crop_age_days": crop_age_days,
            "days_until_target_harvest": days_until_target,
            "plant_density_per_m2": count / area,
            **sensor_values,
        }
        columns = self._routes[route]["features"]
        features = pd.DataFrame(
            [{name: feature_values[name] for name in columns}], columns=columns
        )

        try:
            predicted_yield = float(self._routes[route]["pipeline"].predict(features)[0])
        except Exception:
            return self._unavailable(
                "INFERENCE_FAILED", "The selected model route could not produce a prediction"
            )
        predicted_quantity = predicted_yield * area
        if not math.isfinite(predicted_quantity):
            return self._unavailable(
                "NONFINITE_PREDICTION", "The selected model returned a non-finite quantity"
            )
        return {
            "status": "PREDICTED",
            "predicted_quantity_kg": max(0.0, predicted_quantity),
            "model_version": self.model_version,
            "inference_route": route,
            "training_provenance": self.training_provenance,
        }
