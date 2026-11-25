# Kontrak fitur, validasi nilai, dan pemilihan jalur berdasarkan ketersediaan sensor.

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd


SUPPORTED_CROPS = (
    "AMARANTH",
    "KANGKUNG",
    "LETTUCE",
    "PAKCHOY",
    "MUSTARD_GREENS",
    "SPINACH",
    "KALE",
)
LOCAL_TIMEZONE = timezone(timedelta(hours=7), name="Asia/Jakarta")
MIN_SENSOR_COVERAGE = 0.80
MAX_SENSOR_STALENESS_HOURS = 24.0
DEFAULT_WINDOW_SLOTS = 672

FEATURE_ALLOWLISTS = {
    "full": (
        "crop_id",
        "crop_age_days",
        "days_until_target_harvest",
        "air_temp_mean_7d_c",
        "air_temp_max_7d_c",
        "humidity_mean_7d_pct",
        "soil_moisture_mean_7d_pct",
        "soil_moisture_min_7d_pct",
        "plant_density_per_m2",
    ),
    "air": (
        "crop_id",
        "crop_age_days",
        "days_until_target_harvest",
        "air_temp_mean_7d_c",
        "air_temp_max_7d_c",
        "humidity_mean_7d_pct",
        "plant_density_per_m2",
    ),
    "manual": (
        "crop_id",
        "crop_age_days",
        "days_until_target_harvest",
        "plant_density_per_m2",
    ),
}

AIR_FEATURES = (
    "air_temp_mean_7d_c",
    "air_temp_max_7d_c",
    "humidity_mean_7d_pct",
)
SOIL_FEATURES = (
    "soil_moisture_mean_7d_pct",
    "soil_moisture_min_7d_pct",
)


def _finite_number(value: object) -> float | None:
    # Anggap nilai sensor kosong atau tidak terbatas sebagai data yang tidak tersedia.
    if value is None or isinstance(value, (bool, np.bool_)):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _source_is_missing(value: object) -> bool:
    return value is None or str(value).strip().lower() in {
        "",
        "none",
        "null",
        "nan",
        "<na>",
        "unavailable",
    }


def _status_is_stale(quality: Mapping[str, object]) -> bool:
    status = quality.get("status")
    if status is None:
        return False
    return str(status).strip().upper() not in {"SIMULATED", "VALID", "OK", "FRESH"}


def _valid_last_seen(quality: Mapping[str, object], key: str) -> bool:
    hours = _finite_number(quality.get(key))
    return hours is not None and 0.0 <= hours <= MAX_SENSOR_STALENESS_HOURS


def _valid_slot_coverage(
    quality: Mapping[str, object], slot_keys: tuple[str, ...]
) -> bool:
    expected = _finite_number(quality.get("expected_window_slots"))
    expected = expected if expected is not None else float(DEFAULT_WINDOW_SLOTS)
    if expected <= 0 or not expected.is_integer():
        return False
    for key in slot_keys:
        slots = _finite_number(quality.get(key))
        if slots is None or not slots.is_integer() or slots < 0 or slots > expected:
            return False
        if slots / expected < MIN_SENSOR_COVERAGE:
            return False
    return True


def _valid_air_measurements(values: Mapping[str, object]) -> bool:
    mean = _finite_number(values.get("air_temp_mean_7d_c"))
    maximum = _finite_number(values.get("air_temp_max_7d_c"))
    humidity = _finite_number(values.get("humidity_mean_7d_pct"))
    return (
        mean is not None
        and maximum is not None
        and humidity is not None
        and -15.0 <= mean <= 60.0
        and -15.0 <= maximum <= 60.0
        and mean <= maximum
        and 0.0 <= humidity <= 100.0
    )


def _valid_soil_measurements(values: Mapping[str, object]) -> bool:
    mean = _finite_number(values.get("soil_moisture_mean_7d_pct"))
    minimum = _finite_number(values.get("soil_moisture_min_7d_pct"))
    return (
        mean is not None
        and minimum is not None
        and 0.0 <= minimum <= mean <= 100.0
    )


def select_route(
    values: Mapping[str, object], quality: Mapping[str, object] | None
) -> str:
    # Ringkasan cuaca memakai metadata sumber; pembacaan IoT juga perlu cakupan dan kesegaran.
    if not isinstance(quality, Mapping) or _status_is_stale(quality):
        return "manual"

    air_source = quality.get("air_source")
    air_is_weather_api = (
        air_source is not None
        and "weather" in str(air_source).strip().lower()
        and "api" in str(air_source).strip().lower()
    )
    air_source_declares_missing = _source_is_missing(air_source)
    air_measurements_ok = _valid_air_measurements(values)

    if air_is_weather_api:
        age_value = quality.get("air_last_seen_hours")
        age_missing = age_value is None or _finite_number(age_value) is None
        air_quality_ok = age_missing or _valid_last_seen(quality, "air_last_seen_hours")
    else:
        air_quality_ok = (
            not air_source_declares_missing
            and _valid_slot_coverage(
                quality, ("temperature_valid_slots", "humidity_valid_slots")
            )
            and _valid_last_seen(quality, "air_last_seen_hours")
        )
    air_available = air_measurements_ok and air_quality_ok

    soil_source = quality.get("soil_source")
    soil_available = (
        not _source_is_missing(soil_source)
        and _valid_soil_measurements(values)
        and _valid_slot_coverage(quality, ("soil_valid_slots",))
        and _valid_last_seen(quality, "soil_last_seen_hours")
    )

    if air_available and soil_available:
        return "full"
    if air_available:
        return "air"
    return "manual"


def parse_prediction_dates(
    planting_date: object,
    prediction_at: object,
    target_harvest_date: object,
) -> tuple[int, int]:
    # Hitung umur tanaman dan jarak ke panen dalam waktu Jakarta setelah memvalidasi tanggal.
    if isinstance(planting_date, datetime):
        raise ValueError("planting_date must be a date, not a datetime")
    if isinstance(target_harvest_date, datetime):
        raise ValueError("target_harvest_date must be a date, not a datetime")
    if isinstance(planting_date, date):
        planted = planting_date
    elif isinstance(planting_date, str):
        planted = date.fromisoformat(planting_date)
    else:
        raise ValueError("planting_date must use YYYY-MM-DD")
    if isinstance(target_harvest_date, date):
        target = target_harvest_date
    elif isinstance(target_harvest_date, str):
        target = date.fromisoformat(target_harvest_date)
    else:
        raise ValueError("target_harvest_date must use YYYY-MM-DD")

    if isinstance(prediction_at, datetime):
        prediction_dt = prediction_at
    elif isinstance(prediction_at, str):
        raw = prediction_at.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        prediction_dt = datetime.fromisoformat(raw)
    else:
        raise ValueError("prediction_at must be an RFC3339 timestamp")
    if prediction_dt.tzinfo is None or prediction_dt.utcoffset() is None:
        raise ValueError("prediction_at must include a timezone offset")

    local_day = prediction_dt.astimezone(LOCAL_TIMEZONE).date()
    age_days = (local_day - planted).days
    horizon_days = (target - local_day).days
    if age_days < 0:
        raise ValueError("planting_date cannot be after prediction_at")
    if horizon_days < 1:
        raise ValueError("target_harvest_date must be at least one day after prediction_at")
    return age_days, horizon_days


def build_features(frame: pd.DataFrame, route: str) -> pd.DataFrame:
    # Bentuk hanya fitur yang diizinkan untuk jalur yang dipilih.
    if route not in FEATURE_ALLOWLISTS:
        raise ValueError(f"Unknown prediction route: {route}")
    required = {
        "crop_id",
        "planting_date",
        "prediction_at",
        "target_harvest_date",
        "planted_area_m2",
        "plant_count",
    }
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"Missing feature source columns: {missing}")

    crops = frame["crop_id"].astype("string").str.strip().str.upper()
    unsupported = sorted(set(crops.dropna()) - set(SUPPORTED_CROPS))
    if crops.isna().any() or unsupported:
        raise ValueError(f"Unsupported or missing crop categories: {unsupported}")

    ages: list[int] = []
    horizons: list[int] = []
    for row in frame.itertuples(index=False):
        values = row._asdict()
        age, horizon = parse_prediction_dates(
            values["planting_date"],
            values["prediction_at"],
            values["target_harvest_date"],
        )
        ages.append(age)
        horizons.append(horizon)

    areas = pd.to_numeric(frame["planted_area_m2"], errors="raise").astype(float)
    counts = pd.to_numeric(frame["plant_count"], errors="raise").astype(float)
    if (
        not np.isfinite(areas.to_numpy()).all()
        or not np.isfinite(counts.to_numpy()).all()
        or (areas <= 0).any()
        or (counts <= 0).any()
        or ((counts % 1) != 0).any()
    ):
        raise ValueError("planted_area_m2 and plant_count must be finite and positive")

    result = pd.DataFrame(index=frame.index)
    result["crop_id"] = crops.astype(str)
    result["crop_age_days"] = ages
    result["days_until_target_harvest"] = horizons
    result["plant_density_per_m2"] = counts / areas
    for name in AIR_FEATURES + SOIL_FEATURES:
        if name in frame:
            result[name] = pd.to_numeric(frame[name], errors="raise")
        else:
            result[name] = np.nan
    return result.loc[:, FEATURE_ALLOWLISTS[route]].copy()


def normalized_yield(frame: pd.DataFrame) -> np.ndarray:
    # Pertahankan hasil panen nol dan nyatakan target dalam kg per meter persegi.
    if "actual_harvest_kg" not in frame or "planted_area_m2" not in frame:
        raise ValueError("actual_harvest_kg and planted_area_m2 are required")
    target = pd.to_numeric(frame["actual_harvest_kg"], errors="raise").to_numpy(float)
    area = pd.to_numeric(frame["planted_area_m2"], errors="raise").to_numpy(float)
    if (
        not np.isfinite(target).all()
        or not np.isfinite(area).all()
        or (target < 0).any()
        or (area <= 0).any()
    ):
        raise ValueError("Targets must be finite and non-negative; area must be positive")
    return target / area
