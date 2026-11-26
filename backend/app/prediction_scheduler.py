from __future__ import annotations
import logging
import threading
import time
from datetime import date
from fastapi import HTTPException
from .core import session_factory, settings
from .services.svc_02_farm_record import FarmRecordService
from .services.svc_03_prediction import HarvestPredictionService

log = logging.getLogger("smartharvest.scheduler")


def period_from_iso_date(iso_date: str) -> str:
    cal = date.fromisoformat(iso_date).isocalendar()
    return f"{cal.year}-W{cal.week:02d}"


class PredictionScheduler:
    """B08: Automated per-planting prediction orchestrator calling SVC-03."""

    def __init__(self, interval_seconds: int | None = None):
        self.interval = max(15, int(interval_seconds or settings.prediction_interval_seconds))
        self.stop_event = threading.Event()
        self.wakeup = threading.Event()
        self._lock = threading.Lock()
        self._pending: dict[tuple[str, str, str], str] = {}
        self.thread: threading.Thread | None = None

    def enqueue(self, farm_id: str, crop_id: str, period: str, trigger: str = "event") -> None:
        with self._lock:
            self._pending[(farm_id, crop_id, period)] = trigger
        self.wakeup.set()

    def enqueue_all_active(self, trigger: str = "scheduled") -> int:
        session = session_factory()()
        count = 0
        try:
            plantings = FarmRecordService(session).list_active_plantings()
            for p in plantings:
                period = period_from_iso_date(p["target_harvest_date"])
                self.enqueue(p["farm_id"], p["crop_id"], period, trigger=trigger)
                count += 1
        except Exception as exc:
            log.warning("Failed to list active plantings (%s)", type(exc).__name__)
        finally:
            session.close()
        return count

    def run_pending(self) -> list[dict]:
        with self._lock:
            batch = list(self._pending.items())
            self._pending.clear()
        results: list[dict] = []
        for (farm_id, crop_id, period), trigger in batch:
            session = session_factory()()
            try:
                farm = FarmRecordService(session)
                svc = HarvestPredictionService(session, farm)
                pred = svc.generate(
                    {"farm_id": farm_id, "crop_id": crop_id, "target_period": period, "data_reference_ids": []},
                    principal=None,
                    trigger=trigger,
                    skip_if_unchanged=True,
                )
                session.commit()
                results.append(pred)
            except HTTPException as exc:
                session.commit()  # persist PredictionState unavailable/stale update
                log.info("Automated prediction skipped for %s/%s/%s (%s)", farm_id, crop_id, period, exc.status_code)
            except Exception as exc:
                session.rollback()
                log.warning("Automated prediction error for %s/%s/%s (%s)", farm_id, crop_id, period, type(exc).__name__)
            finally:
                session.close()
        return results

    def start(self) -> None:
        self.enqueue_all_active(trigger="startup")
        self.thread = threading.Thread(target=self._loop, name="prediction-scheduler", daemon=True)
        self.thread.start()

    def _loop(self) -> None:
        last_periodic = time.monotonic()
        while not self.stop_event.is_set():
            if self._pending:
                self.run_pending()
            now = time.monotonic()
            if now - last_periodic >= self.interval:
                self.enqueue_all_active(trigger="scheduled")
                self.run_pending()
                last_periodic = now
            self.wakeup.wait(timeout=1.0)
            self.wakeup.clear()

    def close(self) -> None:
        self.stop_event.set()
        self.wakeup.set()
        if self.thread:
            self.thread.join(timeout=2)


_scheduler: PredictionScheduler | None = None


def get_scheduler() -> PredictionScheduler | None:
    return _scheduler


def set_scheduler(instance: PredictionScheduler | None) -> None:
    global _scheduler
    _scheduler = instance
