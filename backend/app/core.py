from __future__ import annotations
from datetime import datetime, timezone
from typing import Generator
from fastapi import Depends, HTTPException
from fastapi.security import APIKeyCookie
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import JSON, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, create_engine, select, text, update
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

RECORD_KINDS = (
    "Farm",
    "Crop",
    "Planting",
    "Device",
    "Member",
    "Receipt",
    "Observation",
    "HarvestEstimate",
    "HarvestPrediction",
    "PredictionState",
    "ApprovedAvailability",
    "SupplyRiskAssessment",
    "CommodityPlan",
    "AllocationAdjustment",
    "MemberSelection",
    "ActualHarvest",
    "MemberFeedback",
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    app_env: str = "development"
    database_url: str = "postgresql+psycopg://smartharvest:smartharvest@db:5432/smartharvest"
    cors_origins: str = "http://127.0.0.1:5173"
    trusted_hosts: str = "localhost,127.0.0.1,web,api"
    model_path: str = "ai/models/model.joblib"
    model_enabled: bool = True
    mqtt_enabled: bool = False
    mqtt_source: str = "iot"
    mqtt_host: str = "broker.hivemq.com"
    mqtt_port: int = 1883
    mqtt_transport: str = "tcp"
    mqtt_topic: str = "tani/sensor/lingkungan"
    mqtt_qos: int = 0
    mqtt_client_id: str = ""
    mqtt_farm_id: str = ""
    mqtt_device_id: str = ""
    mqtt_wire_block_id: str = "BLOK-A1"
    mqtt_crop_id: str = ""
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_tls: bool = False
    prediction_scheduler_enabled: bool = False
    prediction_interval_seconds: int = 900
    sensor_stale_seconds: int = 30
    sensor_offline_seconds: int = 120
    auth_bootstrap_farmer_username: str = ""
    auth_bootstrap_farmer_password: str = ""
    auth_bootstrap_coordinator_username: str = ""
    auth_bootstrap_coordinator_password: str = ""
    auth_bootstrap_member_eligible_username: str = ""
    auth_bootstrap_member_eligible_password: str = ""
    auth_bootstrap_member_regular_username: str = ""
    auth_bootstrap_member_regular_password: str = ""
    session_cookie_secure: bool = False
    session_ttl_hours: int = 12
    public_profile: bool = False


settings = Settings()


class Base(DeclarativeBase):
    pass


_KIND_SQL = ",".join(f"'{k}'" for k in RECORD_KINDS)


class Record(Base):
    __tablename__ = "records"
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_records_version_positive"),
        CheckConstraint(f"kind IN ({_KIND_SQL})", name="ck_records_kind"),
        Index(
            "uq_member_period_selection",
            "owner_id",
            "period",
            unique=True,
            postgresql_where=text("kind = 'MemberSelection'"),
            sqlite_where=text("kind = 'MemberSelection'"),
        ),
        Index(
            "uq_active_availability_scope",
            "farm_id",
            "crop_id",
            "period",
            unique=True,
            postgresql_where=text("kind = 'ApprovedAvailability'"),
            sqlite_where=text("kind = 'ApprovedAvailability'"),
        ),
        Index("ix_records_kind_farm_created", "kind", "farm_id", "created_at"),
    )
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    kind: Mapped[str] = mapped_column(String(48), index=True)
    farm_id: Mapped[str | None] = mapped_column(String(80), ForeignKey("records.id", name="fk_records_farm_id"), index=True)
    crop_id: Mapped[str | None] = mapped_column(String(48), ForeignKey("records.id", name="fk_records_crop_id"), index=True)
    period: Mapped[str | None] = mapped_column(String(8), index=True)
    owner_id: Mapped[str | None] = mapped_column(String(80), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(80), index=True)
    resource_id: Mapped[str] = mapped_column(String(80), index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    details: Mapped[dict] = mapped_column(JSON, default=dict)


_engine = None
_Session = None


def configure_database(url: str | None = None):
    global _engine, _Session
    db_url = url or settings.database_url
    kwargs = {"check_same_thread": False} if db_url.startswith("sqlite") else {}
    _engine = create_engine(db_url, pool_pre_ping=True, connect_args=kwargs)
    _Session = sessionmaker(_engine, expire_on_commit=False)
    return _engine


def session_factory():
    global _Session
    if _Session is None:
        configure_database()
    return _Session


def init_db():
    if _engine is None:
        configure_database()
    Base.metadata.create_all(_engine)


def get_session() -> Generator[Session, None, None]:
    session = session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


class Principal:
    def __init__(self, user_id, role, name, farm_ids=(), member_id=None, can_select=False):
        self.user_id, self.role, self.name = user_id, role, name
        self.farm_ids = set(farm_ids)
        self.member_id = member_id
        self.can_select = can_select


session_cookie = APIKeyCookie(
    name="smartharvest_session",
    scheme_name="SessionCookie",
    description="Opaque HttpOnly browser session",
    auto_error=False,
)


def current_principal(
    session_token: str | None = Depends(session_cookie),
    session: Session = Depends(get_session),
) -> Principal:
    from .auth import AuthService
    principal, _ = AuthService(session).authenticate(session_token)
    return principal


def require_role(*roles: str):
    def dependency(principal: Principal = Depends(current_principal)):
        if principal.role not in roles:
            raise HTTPException(403, detail={"code": "FORBIDDEN", "message": "Role is not permitted"})
        return principal
    return dependency


def error(code, message, status=422):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


def verify_scope(principal, farm_id):
    if principal.role == "FARMER" and farm_id not in principal.farm_ids:
        error("FORBIDDEN", "Farm is not assigned to this account", 403)
    if principal.role not in {"FARMER", "COORDINATOR"}:
        error("FORBIDDEN", "Farm access is not permitted", 403)


def record(session: Session, kind: str, id: str):
    row = session.get(Record, id)
    return row if row and row.kind == kind else None


def save(session: Session, kind: str, payload: dict, *, id, farm_id=None, crop_id=None, period=None, owner_id=None, version=1):
    row = Record(
        id=id, kind=kind, farm_id=farm_id, crop_id=crop_id, period=period, owner_id=owner_id, version=version, payload=payload
    )
    session.add(row)
    session.flush()
    return row


def update_versioned(session: Session, row: Record, expected: int, payload: dict):
    result = session.execute(
        update(Record).where(Record.id == row.id, Record.version == expected).values(version=expected + 1, payload=payload)
    )
    if result.rowcount != 1:
        error("VERSION_CONFLICT", "Record changed; reload before retrying", 409)
    session.refresh(row)
    return row


def list_records(session: Session, kind: str, *, limit: int | None = 500, **filters):
    query = select(Record).where(Record.kind == kind)
    for field, value in filters.items():
        if value is not None:
            query = query.where(getattr(Record, field) == value)
    query = query.order_by(Record.created_at.desc())
    if limit is not None:
        query = query.limit(limit)
    return session.scalars(query).all()


def utcnow():
    return datetime.now(timezone.utc)


def iso(value: datetime):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
