from __future__ import annotations
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from . import auth_models
from .api import router
from .auth import AuthService
from .core import configure_database, init_db, session_factory, settings
from .prediction_scheduler import PredictionScheduler, set_scheduler
from .services.svc_02_farm_record import FarmRecordService

log = logging.getLogger("smartharvest")
_worker = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _worker
    if settings.app_env == "production" and not settings.session_cookie_secure:
        raise RuntimeError("Production session cookies must use Secure")
    configure_database()
    init_db()
    session = session_factory()()
    try:
        FarmRecordService(session).seed()
        AuthService(session).bootstrap()
        session.commit()
    finally:
        session.close()
    if settings.mqtt_enabled:
        try:
            from .mqtt_worker import MQTTWorker

            _worker = MQTTWorker()
            _worker.start()
        except Exception as exc:
            log.error("MQTT worker unavailable (%s)", type(exc).__name__)
            _worker = None
    scheduler = None
    if settings.prediction_scheduler_enabled:
        scheduler = PredictionScheduler(settings.prediction_interval_seconds)
        set_scheduler(scheduler)
        scheduler.start()
    yield
    if scheduler:
        scheduler.close()
        set_scheduler(None)
    if _worker:
        _worker.close()
        _worker = None


def create_app():
    public = settings.public_profile or settings.app_env == "production"
    app = FastAPI(
        title="SmartHarvest API",
        version="1.1.0",
        docs_url=None if public else "/docs",
        redoc_url=None if public else "/redoc",
        openapi_url=None if public else "/openapi.json",
        lifespan=lifespan,
    )
    origins = [x.strip() for x in settings.cors_origins.split(",") if x.strip()]
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=[x.strip() for x in settings.trusted_hosts.split(",") if x.strip()],
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Accept", "X-CSRF-Token"],
    )

    @app.middleware("http")
    async def request_limits(request: Request, call_next):
        size = request.headers.get("content-length")
        if size and size.isdigit() and int(size) > 65536:
            return JSONResponse(
                status_code=413,
                content={"error": {"code": "REQUEST_TOO_LARGE", "message": "Request body exceeds 64 KiB"}},
            )
        if (
            request.method == "POST"
            and size
            and int(size) > 0
            and request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json"
        ):
            return JSONResponse(
                status_code=415,
                content={"error": {"code": "UNSUPPORTED_MEDIA_TYPE", "message": "Content-Type must be application/json"}},
            )
        return await call_next(request)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
        return JSONResponse(status_code=exc.status_code, content={"error": detail}, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        is_syntax = any(item.get("type") == "json_invalid" for item in exc.errors())
        status = 400 if is_syntax else 422
        return JSONResponse(
            status_code=status,
            content={
                "error": {
                    "code": "INVALID_JSON" if is_syntax else "VALIDATION_ERROR",
                    "message": "Request JSON syntax is invalid" if is_syntax else "Request fields or rules are invalid",
                }
            },
        )

    @app.exception_handler(Exception)
    async def internal_error(request, exc):
        log.exception("Unhandled request error")
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "INTERNAL_ERROR", "message": "Request could not be completed"}},
        )

    app.include_router(router)

    @app.get("/health/live", include_in_schema=False)
    def live():
        return {"status": "ok"}

    @app.get("/health/ready", include_in_schema=False)
    def ready():
        try:
            from sqlalchemy import text

            with session_factory()() as session:
                session.execute(text("SELECT 1"))
            mqtt_status = "disabled"
            if settings.mqtt_enabled:
                mqtt_status = _worker.state if _worker is not None else "disconnected"
            return {"status": "ready", "database": "ready", "mqtt": mqtt_status}
        except Exception:
            return JSONResponse(status_code=503, content={"status": "not_ready", "database": "unavailable"})

    return app


app = create_app()
