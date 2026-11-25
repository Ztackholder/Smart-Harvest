# Latih, pilih, serialisasi, dan evaluasi model SVC-03 SmartHarvest.

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.tree import DecisionTreeRegressor
from sklearn.ensemble import RandomForestRegressor

from .features import (
    AIR_FEATURES,
    FEATURE_ALLOWLISTS,
    SUPPORTED_CROPS,
    build_features,
    normalized_yield,
    parse_prediction_dates,
    select_route,
)
from .predict import HarvestPredictor
from .preprocessing import make_pipeline


CORE_COLUMNS = (
    "farm_id",
    "plot_id",
    "planting_id",
    "crop_id",
    "planting_date",
    "prediction_at",
    "target_harvest_date",
    "target_period",
    "planted_area_m2",
    "crop_age_days",
    "days_until_target_harvest",
    "air_temp_mean_7d_c",
    "air_temp_max_7d_c",
    "humidity_mean_7d_pct",
    "soil_moisture_mean_7d_pct",
    "soil_moisture_min_7d_pct",
    "plant_count",
    "estimated_quantity_kg",
    "actual_harvest_kg",
    "soil_condition",
    "valid_sensor_readings_7d",
)
INPUT_COLUMNS = tuple(name for name in CORE_COLUMNS if name != "actual_harvest_kg")
QUALITY_COLUMNS = (
    "planting_id",
    "scenario",
    "air_source",
    "soil_source",
    "temperature_valid_slots",
    "humidity_valid_slots",
    "soil_valid_slots",
    "temperature_coverage",
    "humidity_coverage",
    "soil_coverage",
    "air_last_seen_hours",
    "soil_last_seen_hours",
    "sample_interval_minutes",
    "expected_window_slots",
    "status",
    "source_is_real_hardware",
)


class DatasetIntegrityError(ValueError):
    # Digunakan saat data v3 tidak memenuhi kontrak yang didokumentasikan.


def _require_columns(frame: pd.DataFrame, expected: tuple[str, ...], name: str) -> None:
    if tuple(frame.columns) != expected:
        missing = sorted(set(expected) - set(frame.columns))
        extra = sorted(set(frame.columns) - set(expected))
        raise DatasetIntegrityError(
            f"{name} columns do not match the v3 contract (missing={missing}, extra={extra})"
        )


def verify_manifest(data_dir: Path) -> dict[str, Any]:
    manifest_path = data_dir / "manifest.json"
    if not manifest_path.is_file():
        raise DatasetIntegrityError(f"Dataset manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for relative_name, entry in manifest.get("files", {}).items():
        path = data_dir / relative_name
        if not path.is_file():
            raise DatasetIntegrityError(f"Manifest file is missing: {path}")
        if path.stat().st_size != entry.get("bytes"):
            raise DatasetIntegrityError(f"Manifest size mismatch: {relative_name}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != entry.get("sha256"):
            raise DatasetIntegrityError(f"Manifest SHA-256 mismatch: {relative_name}")
    if manifest.get("status") != "100% SYNTHETIC":
        raise DatasetIntegrityError("The v3 manifest provenance is not marked synthetic")
    return manifest


def _load_data(data_dir: Path) -> dict[str, pd.DataFrame]:
    files = {
        "train": "train.csv",
        "validation": "validation.csv",
        "pool": "training_pool_4500.csv",
        "test_inputs": "test_inputs.csv",
        "train_quality": "train_metadata.csv",
        "validation_quality": "validation_metadata.csv",
        "test_quality": "test_metadata.csv",
    }
    result = {key: pd.read_csv(data_dir / filename) for key, filename in files.items()}
    for name in ("train", "validation", "pool"):
        _require_columns(result[name], CORE_COLUMNS, name)
    _require_columns(result["test_inputs"], INPUT_COLUMNS, "test_inputs")
    for name in ("train_quality", "validation_quality", "test_quality"):
        _require_columns(result[name], QUALITY_COLUMNS, name)
    return result


def _assert_unique_ids(frame: pd.DataFrame, name: str) -> None:
    if frame["planting_id"].isna().any() or frame["planting_id"].duplicated().any():
        raise DatasetIntegrityError(f"{name} must have one unique planting_id per row")


def _attach_quality(frame: pd.DataFrame, quality: pd.DataFrame, name: str) -> pd.DataFrame:
    _assert_unique_ids(frame, name)
    _assert_unique_ids(quality, f"{name} quality metadata")
    if set(frame["planting_id"]) != set(quality["planting_id"]):
        raise DatasetIntegrityError(f"{name} and its quality sidecar have different planting IDs")
    return frame.merge(quality, on="planting_id", how="left", validate="one_to_one")


def _check_sensor_values(frame: pd.DataFrame, name: str) -> None:
    ranges = {
        "air_temp_mean_7d_c": (-15.0, 60.0),
        "air_temp_max_7d_c": (-15.0, 60.0),
        "humidity_mean_7d_pct": (0.0, 100.0),
        "soil_moisture_mean_7d_pct": (0.0, 100.0),
        "soil_moisture_min_7d_pct": (0.0, 100.0),
    }
    for column, (lower, upper) in ranges.items():
        values = pd.to_numeric(frame[column], errors="raise")
        present = values.dropna()
        if not np.isfinite(present.to_numpy(dtype=float)).all():
            raise DatasetIntegrityError(f"{name}.{column} contains a non-finite value")
        if ((present < lower) | (present > upper)).any():
            raise DatasetIntegrityError(f"{name}.{column} is outside the v3 feature range")
    if (
        frame["air_temp_mean_7d_c"].notna()
        & frame["air_temp_max_7d_c"].notna()
        & (frame["air_temp_mean_7d_c"] > frame["air_temp_max_7d_c"])
    ).any():
        raise DatasetIntegrityError(f"{name} has air max below air mean")
    if (
        frame["soil_moisture_min_7d_pct"].notna()
        & frame["soil_moisture_mean_7d_pct"].notna()
        & (frame["soil_moisture_min_7d_pct"] > frame["soil_moisture_mean_7d_pct"])
    ).any():
        raise DatasetIntegrityError(f"{name} has soil minimum above soil mean")


def _validate_rows(frame: pd.DataFrame, name: str, has_target: bool) -> None:
    _assert_unique_ids(frame, name)
    crops = set(frame["crop_id"].dropna().astype(str))
    if crops - set(SUPPORTED_CROPS) or frame["crop_id"].isna().any():
        raise DatasetIntegrityError(f"{name} has unsupported or missing crop categories")
    periods = []
    for value in frame["target_harvest_date"]:
        target_date = pd.Timestamp(value).date()
        iso = target_date.isocalendar()
        periods.append(f"{iso.year}-W{iso.week:02d}")
    if not np.array_equal(frame["target_period"].astype(str).to_numpy(), np.asarray(periods)):
        raise DatasetIntegrityError(f"{name}.target_period does not match target_harvest_date")
    area = pd.to_numeric(frame["planted_area_m2"], errors="raise").to_numpy(float)
    count = pd.to_numeric(frame["plant_count"], errors="raise").to_numpy(float)
    if (
        not np.isfinite(area).all()
        or not np.isfinite(count).all()
        or (area <= 0).any()
        or (count <= 0).any()
        or ((count % 1) != 0).any()
    ):
        raise DatasetIntegrityError(f"{name} has invalid area or plant_count")
    estimates = pd.to_numeric(frame["estimated_quantity_kg"], errors="raise").to_numpy(float)
    if not np.isfinite(estimates).all() or (estimates < 0).any():
        raise DatasetIntegrityError(f"{name} has invalid farmer estimates")
    quality_counts = pd.to_numeric(frame["valid_sensor_readings_7d"], errors="raise").to_numpy(float)
    if not np.isfinite(quality_counts).all() or (quality_counts < 0).any() or (quality_counts > 672).any():
        raise DatasetIntegrityError(f"{name} has invalid valid_sensor_readings_7d")

    derived = build_features(frame, "manual")
    for column in ("crop_age_days", "days_until_target_harvest"):
        if column in frame:
            supplied = pd.to_numeric(frame[column], errors="raise").to_numpy(int)
            if not np.array_equal(supplied, derived[column].to_numpy(int)):
                raise DatasetIntegrityError(f"{name}.{column} does not match the date fields")
    if has_target:
        normalized_yield(frame)
    elif "actual_harvest_kg" in frame:
        raise DatasetIntegrityError(f"{name} must not contain target labels")
    _check_sensor_values(frame, name)


def _validate_quality(frame: pd.DataFrame, name: str) -> None:
    expected = pd.to_numeric(frame["expected_window_slots"], errors="raise").to_numpy(float)
    if not np.isfinite(expected).all() or (expected <= 0).any():
        raise DatasetIntegrityError(f"{name} has invalid expected window sizes")
    for column in (
        "temperature_valid_slots",
        "humidity_valid_slots",
        "soil_valid_slots",
    ):
        values = pd.to_numeric(frame[column], errors="raise").to_numpy(float)
        if (
            not np.isfinite(values).all()
            or (values < 0).any()
            or (values > expected).any()
            or ((values % 1) != 0).any()
        ):
            raise DatasetIntegrityError(f"{name}.{column} is outside its valid range")
    for field, count_field in (
        ("temperature_coverage", "temperature_valid_slots"),
        ("humidity_coverage", "humidity_valid_slots"),
        ("soil_coverage", "soil_valid_slots"),
    ):
        coverage = pd.to_numeric(frame[field], errors="raise").to_numpy(float)
        count = pd.to_numeric(frame[count_field], errors="raise").to_numpy(float)
        if (
            not np.isfinite(coverage).all()
            or (coverage < 0).any()
            or (coverage > 1).any()
            or (np.abs(coverage - count / expected) > 0.0001).any()
        ):
            raise DatasetIntegrityError(f"{name}.{field} does not match its slot count")
    statuses = set(frame["status"].dropna().astype(str).str.upper())
    if statuses - {"SIMULATED", "STALE"}:
        raise DatasetIntegrityError(f"{name} contains an unknown sensor status")
    if frame["status"].isna().any():
        raise DatasetIntegrityError(f"{name} contains a missing sensor status")
    if frame["source_is_real_hardware"].fillna(True).astype(bool).any():
        raise DatasetIntegrityError(f"{name} contains provenance not marked synthetic")


def _dataset_routes(frame: pd.DataFrame, quality: pd.DataFrame) -> pd.Series:
    joined = _attach_quality(frame, quality, "rows")
    routes = [
        select_route(row, {key: row.get(key) for key in QUALITY_COLUMNS if key != "planting_id"})
        for row in joined.to_dict(orient="records")
    ]
    return pd.Series(routes, index=frame.index, name="route")


def _validate_partitions(data: dict[str, pd.DataFrame]) -> None:
    for key in ("train", "validation", "pool", "test_inputs"):
        _validate_rows(data[key], key, has_target=key != "test_inputs")
    for key in ("train_quality", "validation_quality", "test_quality"):
        _validate_quality(data[key], key)

    train_ids = set(data["train"]["planting_id"])
    validation_ids = set(data["validation"]["planting_id"])
    test_ids = set(data["test_inputs"]["planting_id"])
    pool_ids = set(data["pool"]["planting_id"])
    if train_ids & validation_ids or train_ids & test_ids or validation_ids & test_ids:
        raise DatasetIntegrityError("Planting IDs overlap across chronological partitions")
    if pool_ids != train_ids | validation_ids:
        raise DatasetIntegrityError("training_pool_4500 is not train plus validation")
    combined = pd.concat([data["train"], data["validation"]], ignore_index=True)
    combined = combined.sort_values("planting_id").reset_index(drop=True)
    supplied_pool = data["pool"].sort_values("planting_id").reset_index(drop=True)
    try:
        pd.testing.assert_frame_equal(combined, supplied_pool, check_dtype=False)
    except AssertionError as exc:
        raise DatasetIntegrityError("training_pool_4500 differs from train plus validation") from exc

    bounds = (
        (data["train"], data["validation"], "train/validation"),
        (data["validation"], data["test_inputs"], "validation/test"),
    )
    for earlier, later, label in bounds:
        earlier_end = pd.to_datetime(earlier["prediction_at"], utc=True).max()
        later_start = pd.to_datetime(later["prediction_at"], utc=True).min()
        if earlier_end >= later_start:
            raise DatasetIntegrityError(f"Prediction records overlap in {label} chronology")


def _check_event_chronology(data_dir: Path, data: dict[str, pd.DataFrame]) -> None:
    events = pd.read_csv(data_dir / "harvest_events.csv")
    required = {"planting_id", "harvested_at", "event_period", "quantity_kg"}
    if not required.issubset(events.columns):
        raise DatasetIntegrityError("harvest_events.csv is missing chronology fields")
    event_dates = pd.to_datetime(events["harvested_at"], errors="raise")
    event_iso = event_dates.dt.isocalendar()
    event_periods = event_iso["year"].astype(str) + "-W" + event_iso["week"].astype(str).str.zfill(2)
    if not np.array_equal(events["event_period"].astype(str).to_numpy(), event_periods.to_numpy()):
        raise DatasetIntegrityError("Harvest event periods do not match their event dates")
    quantities = pd.to_numeric(events["quantity_kg"], errors="raise").to_numpy(float)
    if not np.isfinite(quantities).all() or (quantities < 0).any():
        raise DatasetIntegrityError("Harvest events contain invalid quantities")
    partition_ids = {
        "train": set(data["train"]["planting_id"]),
        "validation": set(data["validation"]["planting_id"]),
        "test": set(data["test_inputs"]["planting_id"]),
    }
    known_ids = set.union(*partition_ids.values())
    if set(events["planting_id"]) - known_ids:
        raise DatasetIntegrityError("Harvest events contain unknown planting IDs")
    for name in ("train", "validation"):
        _check_event_labels(events, data[name], name)
    latest = {}
    for name, ids in partition_ids.items():
        part = events[events["planting_id"].isin(ids)]
        latest[name] = pd.to_datetime(part["harvested_at"], errors="raise").max()
    next_start = {
        "train": pd.to_datetime(data["validation"]["prediction_at"], utc=True).min(),
        "validation": pd.to_datetime(data["test_inputs"]["prediction_at"], utc=True).min(),
    }
    for name in ("train", "validation"):
        if pd.Timestamp(latest[name], tz="UTC") >= next_start[name]:
            raise DatasetIntegrityError(
                f"{name} label outcomes extend into the next prediction partition"
            )


def _check_event_labels(events: pd.DataFrame, labels: pd.DataFrame, name: str) -> None:
    target_periods = labels.set_index("planting_id")["target_period"]
    event_rows = events[events["planting_id"].isin(target_periods.index)].copy()
    event_rows["target_period"] = event_rows["planting_id"].map(target_periods)
    event_rows = event_rows[event_rows["event_period"] == event_rows["target_period"]]
    totals = event_rows.groupby("planting_id")["quantity_kg"].sum()
    reconstructed = labels["planting_id"].map(totals).fillna(0.0).to_numpy(float)
    actual = pd.to_numeric(labels["actual_harvest_kg"], errors="raise").to_numpy(float)
    if not np.allclose(reconstructed, actual, rtol=0.0, atol=0.02001):
        raise DatasetIntegrityError(f"{name} harvest events do not reconcile to target labels")


def _metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float | int]:
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    if len(actual) == 0 or len(actual) != len(predicted):
        raise ValueError("Metrics require equally sized, non-empty arrays")
    r2 = float(r2_score(actual, predicted)) if len(actual) >= 2 else float("nan")
    return {
        "rows": int(len(actual)),
        "mae_kg": float(mean_absolute_error(actual, predicted)),
        "rmse_kg": float(math.sqrt(mean_squared_error(actual, predicted))),
        "r2": r2,
        "bias_pred_minus_actual_kg": float(np.mean(predicted - actual)),
    }


def _format_metrics(metrics: dict[str, float | int]) -> str:
    r2 = metrics["r2"]
    r2_text = f"{r2:.4f}" if math.isfinite(float(r2)) else "n/a"
    return (
        f"n={metrics['rows']:>3} MAE={metrics['mae_kg']:.4f} kg "
        f"RMSE={metrics['rmse_kg']:.4f} kg R2={r2_text} "
        f"bias={metrics['bias_pred_minus_actual_kg']:+.4f} kg"
    )


def _rf_estimator(params: dict[str, Any], seed: int) -> RandomForestRegressor:
    return RandomForestRegressor(
        random_state=seed,
        n_jobs=-1,
        **params,
    )


def _select_hyperparameters(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    train_routes: pd.Series,
    validation_routes: pd.Series,
    seed: int,
) -> tuple[dict[str, Any], dict[str, float | int], Any, list[tuple[dict[str, Any], dict[str, float | int]]]]:
    train_mask = train_routes.eq("full")
    validation_mask = validation_routes.eq("full")
    train_full = train.loc[train_mask]
    validation_full = validation.loc[validation_mask]
    x_train = build_features(train_full, "full")
    y_train = normalized_yield(train_full)
    x_validation = build_features(validation_full, "full")
    actual_kg = pd.to_numeric(validation_full["actual_harvest_kg"]).to_numpy(float)
    area = pd.to_numeric(validation_full["planted_area_m2"]).to_numpy(float)

    grid = [
        {
            "n_estimators": trees,
            "max_features": features,
            "min_samples_leaf": leaf,
            "max_depth": depth,
        }
        for trees in (160, 320)
        for features in ("sqrt", 1.0)
        for leaf in (1, 2)
        for depth in (None, 24)
    ]
    scores = []
    for params in grid:
        pipeline = make_pipeline("full", _rf_estimator(params, seed))
        pipeline.fit(x_train, y_train)
        predicted_kg = np.maximum(0.0, pipeline.predict(x_validation)) * area
        scores.append((params, _metrics(actual_kg, predicted_kg), pipeline))
    scores.sort(
        key=lambda entry: (
            entry[1]["mae_kg"],
            entry[1]["rmse_kg"],
            abs(entry[1]["bias_pred_minus_actual_kg"]),
            entry[0]["n_estimators"],
        )
    )
    best_params, best_metrics, best_pipeline = scores[0]
    report = [(params, metrics) for params, metrics, _ in scores]
    return best_params, best_metrics, best_pipeline, report


def _print_validation_results(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    train_routes: pd.Series,
    validation_routes: pd.Series,
    seed: int,
) -> tuple[dict[str, Any], dict[str, float | int]]:
    train_yield = normalized_yield(train)
    validation_actual = pd.to_numeric(validation["actual_harvest_kg"]).to_numpy(float)
    validation_area = pd.to_numeric(validation["planted_area_m2"]).to_numpy(float)
    validation_full = validation.loc[validation_routes.eq("full")]
    validation_full_actual = pd.to_numeric(validation_full["actual_harvest_kg"]).to_numpy(float)
    validation_full_area = pd.to_numeric(validation_full["planted_area_m2"]).to_numpy(float)

    global_yield = float(train_yield.mean())
    global_quantity = float(pd.to_numeric(train["actual_harvest_kg"]).mean())
    crop_yields = train.assign(_yield_kg_m2=train_yield).groupby("crop_id")["_yield_kg_m2"].mean()
    crop_baseline = validation["crop_id"].map(crop_yields).to_numpy(float) * validation_area
    crop_full_baseline = (
        validation_full["crop_id"].map(crop_yields).to_numpy(float) * validation_full_area
    )
    farmer_all = pd.to_numeric(validation["estimated_quantity_kg"]).to_numpy(float)
    farmer_full = pd.to_numeric(validation_full["estimated_quantity_kg"]).to_numpy(float)
    global_all = np.full(len(validation), global_quantity, dtype=float)
    global_full = np.full(len(validation_full), global_quantity, dtype=float)
    global_yield_all = global_yield * validation_area
    global_yield_full = global_yield * validation_full_area

    print("\nValidation baselines (validation rows, never used to fit preprocessing):")
    for name, prediction in (
        ("global_mean", global_all),
        ("global_mean_yield", global_yield_all),
        ("farmer_estimate", farmer_all),
        ("crop_average_yield", crop_baseline),
    ):
        print(f"  {name:<24} {_format_metrics(_metrics(validation_actual, prediction))}")
    print("\nLike-for-like baselines on full sensor route:")
    for name, prediction in (
        ("global_mean", global_full),
        ("global_mean_yield", global_yield_full),
        ("farmer_estimate", farmer_full),
        ("crop_average_yield", crop_full_baseline),
    ):
        print(
            f"  {name:<24} "
            f"{_format_metrics(_metrics(validation_full_actual, prediction))}"
        )

    full_train = train.loc[train_routes.eq("full")]
    x_train_full = build_features(full_train, "full")
    y_train_full = normalized_yield(full_train)
    x_validation_full = build_features(validation_full, "full")
    print("\nValidation model candidates on full route:")
    for name, estimator in (
        ("Ridge Regression", Ridge(alpha=1.0, solver="lsqr")),
        ("Decision Tree", DecisionTreeRegressor(random_state=seed, min_samples_leaf=1)),
    ):
        pipeline = make_pipeline("full", estimator)
        pipeline.fit(x_train_full, y_train_full)
        predicted = np.maximum(0.0, pipeline.predict(x_validation_full)) * validation_full_area
        print(f"  {name:<24} {_format_metrics(_metrics(validation_full_actual, predicted))}")

    best_params, best_metrics, best_pipeline, tuning = _select_hyperparameters(
        train, validation, train_routes, validation_routes, seed
    )
    print("\nRandom Forest tuning on validation full route (sorted by MAE, then RMSE):")
    for params, metrics in tuning:
        print(f"  {params}  {_format_metrics(metrics)}")
    print(f"\nSelected by validation MAE: {best_params}")
    print(f"  {_format_metrics(best_metrics)}")

    # Diagnostik jalur dilatih hanya dengan data train; hasil validation tidak
    # mengubah hyperparameter yang sudah dipilih.
    train_scopes = {
        "full": train_routes.eq("full"),
        "air": train_routes.isin(("full", "air")),
        "manual": pd.Series(True, index=train.index),
    }
    validation_scopes = {
        "full": validation_routes.eq("full"),
        "air": validation_routes.isin(("full", "air")),
        "manual": pd.Series(True, index=validation.index),
    }
    print("\nValidation route diagnostics with the selected Random Forest configuration:")
    route_models = {"full": best_pipeline}
    for route in ("air", "manual"):
        route_train = train.loc[train_scopes[route]]
        pipeline = make_pipeline(route, _rf_estimator(best_params, seed))
        pipeline.fit(build_features(route_train, route), normalized_yield(route_train))
        route_models[route] = pipeline
    for route in ("full", "air", "manual"):
        validation_route = validation.loc[validation_scopes[route]]
        actual = pd.to_numeric(validation_route["actual_harvest_kg"]).to_numpy(float)
        area = pd.to_numeric(validation_route["planted_area_m2"]).to_numpy(float)
        predicted = np.maximum(
            0.0,
            route_models[route].predict(build_features(validation_route, route)),
        ) * area
        print(f"  {route:<8} {_format_metrics(_metrics(actual, predicted))}")
    return best_params, best_metrics


def _fit_final_routes(
    pool: pd.DataFrame,
    pool_routes: pd.Series,
    params: dict[str, Any],
    seed: int,
) -> dict[str, dict[str, Any]]:
    masks = {
        "full": pool_routes.eq("full"),
        "air": pool_routes.isin(("full", "air")),
        "manual": pd.Series(True, index=pool.index),
    }
    result = {}
    for route in ("full", "air", "manual"):
        rows = pool.loc[masks[route]]
        pipeline = make_pipeline(route, _rf_estimator(params, seed))
        pipeline.fit(build_features(rows, route), normalized_yield(rows))
        result[route] = {
            "features": list(FEATURE_ALLOWLISTS[route]),
            "pipeline": pipeline,
            "training_rows": int(len(rows)),
        }
    return result


def _predict_test_rows(
    predictor: HarvestPredictor,
    test_inputs: pd.DataFrame,
    test_quality: pd.DataFrame,
) -> tuple[pd.DataFrame, list[dict[str, object]]]:
    joined = _attach_quality(test_inputs, test_quality, "test inputs")
    responses = []
    for row in joined.to_dict(orient="records"):
        quality = {name: row.get(name) for name in QUALITY_COLUMNS if name != "planting_id"}
        response = predictor.predict({**row, "sensor_quality": quality})
        responses.append(response)
    return joined, responses


def _print_group_metrics(
    label: str,
    frame: pd.DataFrame,
    actual: np.ndarray,
    predicted: np.ndarray,
    group_column: str,
) -> None:
    print(f"\nTest metrics by {label}:")
    for value in sorted(frame[group_column].astype(str).unique()):
        mask = frame[group_column].astype(str).to_numpy() == value
        print(f"  {value:<22} {_format_metrics(_metrics(actual[mask], predicted[mask]))}")


def _print_benchmark_comparison(
    data_dir: Path,
    test_frame: pd.DataFrame,
    actual: np.ndarray,
    predicted: np.ndarray,
) -> None:
    benchmark_path = data_dir.parent.parent / "artifacts" / "v3" / "final_holdout_report.json"
    if not benchmark_path.is_file():
        print("\nSaved v3 benchmark report not found; skipped reference comparison.")
        return
    report = json.loads(benchmark_path.read_text(encoding="utf-8"))
    print("\nThis run compared with the supplied v3 synthetic holdout benchmark (current - reference):")
    current = _metrics(actual, predicted)
    reference = report["total"]
    print(
        f"  overall MAE {current['mae_kg']:.4f} vs {reference['mae_kg']:.4f} kg "
        f"(delta {current['mae_kg'] - reference['mae_kg']:+.4f}); "
        f"RMSE {current['rmse_kg']:.4f} vs {reference['rmse_kg']:.4f}; "
        f"R2 {current['r2']:.4f} vs {reference['r2']:.4f}; "
        f"bias {current['bias_pred_minus_actual_kg']:+.4f} vs "
        f"{reference['bias_pred_minus_actual_kg']:+.4f} kg"
    )
    for field, key in (("route", "inference_route"), ("crop", "crop_id")):
        ref_groups = report.get("by_route" if field == "route" else "by_crop", {})
        if not ref_groups:
            continue
        print(f"  {field} MAE (current vs reference):")
        for value, expected in sorted(ref_groups.items()):
            mask = test_frame[key].astype(str).to_numpy() == value
            if not mask.any():
                continue
            score = _metrics(actual[mask], predicted[mask])
            print(
                f"    {value:<18} {score['mae_kg']:.4f} vs "
                f"{expected['mae_kg']:.4f} kg"
            )


def evaluate_holdout(
    data_dir: Path,
    test_inputs: pd.DataFrame,
    test_quality: pd.DataFrame,
    model_path: Path,
) -> dict[str, float | int]:
    # Evaluasi predictor tersimpan setelah pemilihan dan pelatihan ulang selesai.
    predictor = HarvestPredictor(model_path)
    test_frame, responses = _predict_test_rows(predictor, test_inputs, test_quality)
    unavailable = [response for response in responses if response["status"] != "PREDICTED"]
    if unavailable:
        raise RuntimeError(f"Test inference returned unavailable for {len(unavailable)} rows")

    # Label aktual baru dibaca setelah model dipilih, dilatih ulang, dan diserialisasi.
    # Label ini tidak digunakan untuk training atau pemilihan model.
    ground_truth = pd.read_csv(data_dir / "test_ground_truth.csv")
    if tuple(ground_truth.columns) != (
        "farm_id",
        "plot_id",
        "planting_id",
        "crop_id",
        "prediction_at",
        "target_harvest_date",
        "target_period",
        "actual_harvest_kg",
    ):
        raise DatasetIntegrityError("test_ground_truth.csv columns do not match the v3 contract")
    if ground_truth["planting_id"].duplicated().any() or set(ground_truth.planting_id) != set(test_inputs.planting_id):
        raise DatasetIntegrityError("Test ground truth and test inputs have different planting IDs")
    for key in ("farm_id", "plot_id", "crop_id", "prediction_at", "target_harvest_date", "target_period"):
        aligned = test_inputs[["planting_id", key]].merge(
            ground_truth[["planting_id", key]],
            on="planting_id",
            how="left",
            suffixes=("_input", "_label"),
            validate="one_to_one",
        )
        if not aligned[f"{key}_input"].astype(str).equals(
            aligned[f"{key}_label"].astype(str)
        ):
            raise DatasetIntegrityError(f"Test input and label {key} values do not match")
    test_target = pd.to_numeric(ground_truth["actual_harvest_kg"], errors="raise").to_numpy(float)
    if not np.isfinite(test_target).all() or (test_target < 0).any():
        raise DatasetIntegrityError("Test ground-truth outcomes must be finite non-negative kg")
    _check_event_labels(pd.read_csv(data_dir / "harvest_events.csv"), ground_truth, "test")
    by_id = {
        str(row["planting_id"]): (response, response["inference_route"])
        for row, response in zip(
            test_inputs.to_dict(orient="records"), responses, strict=True
        )
    }
    test_frame["predicted_quantity_kg"] = test_frame["planting_id"].map(
        lambda key: float(by_id[str(key)][0]["predicted_quantity_kg"])
    )
    test_frame["inference_route"] = test_frame["planting_id"].map(
        lambda key: str(by_id[str(key)][1])
    )
    test_frame = test_frame.merge(
        ground_truth[["planting_id", "actual_harvest_kg"]],
        on="planting_id",
        how="left",
        validate="one_to_one",
    )
    actual = pd.to_numeric(test_frame["actual_harvest_kg"], errors="raise").to_numpy(float)
    predicted = test_frame["predicted_quantity_kg"].to_numpy(float)
    routes = test_frame["inference_route"].astype(str).tolist()
    if not np.isfinite(predicted).all() or (predicted < 0).any():
        raise RuntimeError("Serialized inference returned a non-finite or negative quantity")
    counts = pd.Series(routes).value_counts().sort_index().to_dict()

    print("\nSerialized backend predictor inference routes:")
    print(f"  {counts}")
    print("\nTest metrics:")
    overall = _metrics(actual, predicted)
    print(f"  overall                {_format_metrics(overall)}")
    _print_group_metrics("crop", test_frame, actual, predicted, "crop_id")
    _print_group_metrics("inference route", test_frame, actual, predicted, "inference_route")
    _print_group_metrics("sensor availability scenario", test_frame, actual, predicted, "scenario")

    zero_mask = actual == 0
    residual = predicted - actual
    over = residual > 0
    under = residual < 0
    equal = residual == 0
    print("\nZero-harvest and error-direction analysis:")
    print(
        f"  zero harvest rows={int(zero_mask.sum())}; "
        f"MAE={mean_absolute_error(actual[zero_mask], predicted[zero_mask]):.4f} kg; "
        f"mean prediction={predicted[zero_mask].mean():.4f} kg"
    )
    print(
        f"  overprediction rows={int(over.sum())}, mean excess={residual[over].mean():.4f} kg; "
        f"underprediction rows={int(under.sum())}, mean shortfall={-residual[under].mean():.4f} kg; "
        f"exact={int(equal.sum())}"
    )
    _print_benchmark_comparison(data_dir, test_frame, actual, predicted)
    return overall


def train_and_evaluate(
    data_dir: Path, output_dir: Path, seed: int = 42
) -> dict[str, Any]:
    manifest = verify_manifest(data_dir)
    contract_path = data_dir.parent.parent / "artifacts" / "v3" / "feature_contract.json"
    if not contract_path.is_file():
        raise DatasetIntegrityError("Dataset v3 feature contract is missing")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    for route, allowlist in FEATURE_ALLOWLISTS.items():
        if tuple(contract.get("features", {}).get(route, ())) != tuple(allowlist):
            raise DatasetIntegrityError(f"Local {route} features differ from the v3 contract")

    data = _load_data(data_dir)
    _validate_partitions(data)
    _check_event_chronology(data_dir, data)
    train, validation, pool = data["train"], data["validation"], data["pool"]
    train_routes = _dataset_routes(train, data["train_quality"])
    validation_routes = _dataset_routes(validation, data["validation_quality"])
    pool_routes = _dataset_routes(pool, pd.concat([data["train_quality"], data["validation_quality"]], ignore_index=True))

    print("SmartHarvest v3 dataset audit passed")
    print(
        f"  synthetic={manifest['status']} train={len(train)} validation={len(validation)} "
        f"training_pool={len(pool)} test_inputs={len(data['test_inputs'])}"
    )
    print(
        f"  train_routes={train_routes.value_counts().sort_index().to_dict()} "
        f"validation_routes={validation_routes.value_counts().sort_index().to_dict()}"
    )
    print(
        f"  validation target kg: mean={validation.actual_harvest_kg.mean():.4f}, "
        f"zeros={(validation.actual_harvest_kg == 0).sum()}, "
        f"crops={validation.crop_id.nunique()}"
    )

    params, validation_metrics = _print_validation_results(
        train, validation, train_routes, validation_routes, seed
    )

    routes = _fit_final_routes(pool, pool_routes, params, seed)
    bundle = {
        "artifact_schema": 1,
        "model_version": "rf-synthetic-v3",
        "target": {
            "name": "yield_kg_m2",
            "unit": "kg/m2",
            "output_name": "predicted_quantity_kg",
            "output_unit": "kg",
        },
        "routes": routes,
        "selection": {
            "selected_using": "validation_only",
            "selection_route": "full",
            "selection_metric": "MAE in total kilograms",
            "hyperparameters": params,
            "validation_metrics": validation_metrics,
            "random_state": seed,
        },
        "sensor_routing": {
            "minimum_coverage": 0.80,
            "maximum_staleness_hours": 24.0,
            "weather_api_requires_iot_slots": False,
        },
        "runtime_versions": {
            "scikit_learn": sklearn.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
        },
        "training_provenance": {
            "dataset": "SmartHarvest Research-Informed Synthetic Dataset v3",
            "dataset_version": str(manifest.get("dataset_version", "3.0.0")),
            "synthetic": True,
            "field_validated": False,
            "source_seed": manifest.get("seed"),
            "training_rows": int(len(pool)),
        },
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / "model.joblib"
    joblib.dump(bundle, model_path, compress=3)
    size_kb = model_path.stat().st_size / 1024
    print("\nFinal refit on the supplied train + validation pool:")
    for route, entry in routes.items():
        print(f"  {route:<8} rows={entry['training_rows']} features={len(entry['features'])}")
    print(f"  artifact={model_path} ({size_kb:.1f} KiB)")

    # Label test dibaca setelah pemilihan berbasis validation, pelatihan ulang,
    # serialisasi, dan pemuatan artifact yang akan dipakai backend.
    test_metrics = evaluate_holdout(
        data_dir, data["test_inputs"], data["test_quality"], model_path
    )
    return {
        "model_path": model_path,
        "selected_hyperparameters": params,
        "validation_metrics": validation_metrics,
        "test_metrics": test_metrics,
        "routes": routes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("datasets/data/v3"))
    parser.add_argument("--output-dir", type=Path, default=Path("ai/models"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    result = train_and_evaluate(args.data_dir, args.output_dir, seed=args.seed)
    print("\nTraining and holdout evaluation completed.")
    print(f"  selected={result['selected_hyperparameters']}")
    print(f"  final_test={_format_metrics(result['test_metrics'])}")


if __name__ == "__main__":
    main()
