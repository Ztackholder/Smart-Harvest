from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from .sensor_aggregation import aggregate_observations

CHANNELS = ("air_temperature", "relative_humidity", "soil_moisture_index", "pressure", "soil_raw")
RANGE_CONFIG = {
    "1h": (timedelta(hours=1), 300),      # 12 buckets of 5 minutes
    "24h": (timedelta(hours=24), 900),    # 96 buckets of 15 minutes
    "7d": (timedelta(days=7), 3600),      # 168 buckets of 1 hour
}


def _parse_dt(raw: str | datetime) -> datetime:
    if isinstance(raw, datetime):
        dt = raw
    else:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def build_telemetry_summary(
    observations: list[dict],
    now: datetime,
    *,
    stale_seconds: int = 30,
    offline_seconds: int = 120,
) -> dict:
    sorted_obs = sorted(observations, key=lambda o: _parse_dt(o["observed_at"]), reverse=True)
    agg = aggregate_observations(sorted_obs, now)
    coverage = {
        "air_temperature": agg["quality"]["air_temperature_c"],
        "relative_humidity": agg["quality"]["relative_humidity_pct"],
        "soil_moisture_index": agg["quality"]["soil_moisture_index_pct"],
    }
    if not sorted_obs:
        return {
            "status": "unknown",
            "device_id": None,
            "source": None,
            "provenance": None,
            "last_observed_at": None,
            "last_received_at": None,
            "age_seconds": None,
            "configured_interval_seconds": None,
            "observed_interval_seconds": None,
            "inference_ready": False,
            "readings": {ch: None for ch in CHANNELS},
            "sparklines": {ch: [] for ch in ("air_temperature", "relative_humidity", "soil_moisture_index", "pressure")},
            "coverage": coverage,
            "observation_count_7d": 0,
        }

    latest = sorted_obs[0]
    latest_dt = _parse_dt(latest["observed_at"])
    age_sec = max(0.0, (now.astimezone(timezone.utc) - latest_dt).total_seconds())
    src = latest.get("source")
    eff_stale = 1800 if src == "simulated_iot" else stale_seconds
    eff_offline = 7200 if src == "simulated_iot" else offline_seconds
    if age_sec <= eff_stale:
        status = "online"
    elif age_sec <= eff_offline:
        status = "stale"
    else:
        status = "offline"

    observed_interval = None
    if len(sorted_obs) >= 2:
        prev_dt = _parse_dt(sorted_obs[1]["observed_at"])
        delta = (latest_dt - prev_dt).total_seconds()
        if delta > 0:
            observed_interval = round(delta, 1)

    readings: dict[str, float | None] = {ch: None for ch in CHANNELS}
    for m in latest.get("measurements", []):
        if m.get("type") in readings:
            readings[m["type"]] = float(m["value"])

    recent_slice = list(reversed(sorted_obs[:24]))
    step = max(1, len(recent_slice) // 12)
    sampled = recent_slice[::step][-12:]
    sparklines: dict[str, list[float]] = {ch: [] for ch in ("air_temperature", "relative_humidity", "soil_moisture_index", "pressure")}
    for obs in sampled:
        by_type = {m.get("type"): float(m["value"]) for m in obs.get("measurements", []) if m.get("type") in sparklines}
        for ch in sparklines:
            if ch in by_type:
                sparklines[ch].append(round(by_type[ch], 2))

    inference_ready = bool(coverage["air_temperature"]["usable"] and coverage["relative_humidity"]["usable"])

    return {
        "status": status,
        "device_id": latest.get("device_id"),
        "source": src,
        "provenance": latest.get("provenance"),
        "last_observed_at": latest.get("observed_at"),
        "last_received_at": latest.get("recorded_at"),
        "age_seconds": round(age_sec, 1),
        "configured_interval_seconds": 5 if src == "iot" else 900 if src == "simulated_iot" else None,
        "observed_interval_seconds": observed_interval,
        "inference_ready": inference_ready,
        "readings": readings,
        "sparklines": sparklines,
        "coverage": coverage,
        "observation_count_7d": len(sorted_obs),
    }


def build_telemetry_history(
    observations: list[dict],
    now: datetime,
    range_key: str = "24h",
    source: str | None = None,
) -> dict:
    if range_key not in RANGE_CONFIG:
        range_key = "24h"
    span, bucket_sec = RANGE_CONFIG[range_key]
    end = now.astimezone(timezone.utc)
    start = end - span
    bucket_count = int(span.total_seconds() // bucket_sec)
    buckets: dict[int, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))

    for obs in observations:
        if source and source != "all" and obs.get("source") != source:
            continue
        try:
            dt = _parse_dt(obs["observed_at"])
        except (KeyError, ValueError):
            continue
        if dt < start or dt >= end:
            continue
        idx = int((dt - start).total_seconds() // bucket_sec)
        if 0 <= idx < bucket_count:
            for m in obs.get("measurements", []):
                typ = m.get("type")
                if typ in CHANNELS:
                    buckets[idx][typ].append(float(m["value"]))

    series: list[dict] = []
    for idx in range(bucket_count):
        ts = (start + timedelta(seconds=idx * bucket_sec)).isoformat().replace("+00:00", "Z")
        row: dict[str, object] = {"timestamp": ts}
        for ch in CHANNELS:
            vals = buckets[idx].get(ch)
            row[ch] = round(sum(vals) / len(vals), 2) if vals else None
        series.append(row)

    return {
        "range": range_key,
        "bucket_seconds": bucket_sec,
        "window_start": start.isoformat().replace("+00:00", "Z"),
        "window_end": end.isoformat().replace("+00:00", "Z"),
        "series": series,
    }
