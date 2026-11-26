from __future__ import annotations
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from .auth import AuthService
from .auth_models import AuthUser
from .core import Principal, current_principal, get_session, iso, list_records, require_role, settings, verify_scope
from .prediction_scheduler import get_scheduler
from .schemas import (
    ActualIn,
    AdjustmentIn,
    ApprovalIn,
    CommodityPlanIn,
    EstimateIn,
    FeedbackIn,
    ObservationIn,
    PredictionIn,
    ReceiptIn,
    RiskIn,
    SelectionIn,
)
from .services.common import parse_period
from .services.svc_01_farm_data import FarmDataIntegrationService
from .services.svc_02_farm_record import FarmRecordService
from .services.svc_03_prediction import HarvestPredictionService
from .services.svc_04_supply import SupplyCoordinationService
from .services.svc_05_member import MemberInformationService
from .telemetry import build_telemetry_history, build_telemetry_summary


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=16, max_length=256)


def require_csrf(request: Request, db: Session = Depends(get_session)):
    if request.method != "POST" or request.url.path == "/api/v1/auth/login":
        return
    _, session = AuthService(db).authenticate(request.cookies.get("smartharvest_session"))
    if not AuthService(db).csrf_valid(session, request.headers.get("x-csrf-token")):
        raise HTTPException(
            status_code=403,
            detail={"code": "CSRF_FAILED", "message": "A valid session CSRF token is required"},
        )


router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_csrf)])


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_session)):
    service = AuthService(db)
    if not service.origin_matches_host(request.headers.get("origin"), request.headers.get("host")):
        raise HTTPException(
            status_code=403,
            detail={"code": "ORIGIN_REJECTED", "message": "Login origin does not match this site"},
        )
    client_key = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")
    result = service.login(body.username, body.password, client_key)
    response.set_cookie(
        "smartharvest_session",
        result["session_token"],
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        max_age=max(1, min(settings.session_ttl_hours, 24 * 30)) * 3600,
        path="/api/v1",
    )
    return {"user": result["user"], "csrf_token": result["csrf_token"]}


@router.get("/auth/me")
def who_am_i(request: Request, db: Session = Depends(get_session), principal: Principal = Depends(current_principal)):
    principal, session = AuthService(db).authenticate(request.cookies.get("smartharvest_session"))
    user = db.get(AuthUser, principal.user_id)
    return {
        "user": {
            "user_id": principal.user_id,
            "username": user.username,
            "role": principal.role,
            "name": principal.name,
            "farm_ids": sorted(principal.farm_ids),
            "member_id": principal.member_id,
            "can_select": principal.can_select,
        },
        "csrf_token": AuthService(db).rotate_csrf(session),
    }


@router.post("/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_session), principal: Principal = Depends(current_principal)):
    _, session = AuthService(db).authenticate(request.cookies.get("smartharvest_session"))
    AuthService(db).logout(session)
    response.delete_cookie(
        "smartharvest_session",
        path="/api/v1",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return {"status": "signed_out"}


@router.post("/auth/password")
def change_password(
    body: PasswordChangeIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_session),
    user: Principal = Depends(current_principal),
):
    AuthService(db).change_password(user, body.current_password, body.new_password)
    response.delete_cookie(
        "smartharvest_session",
        path="/api/v1",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return {"status": "password_changed", "signed_out": True}


def services(session: Session = Depends(get_session)):
    farm = FarmRecordService(session)
    data = FarmDataIntegrationService(session, farm)
    pred = HarvestPredictionService(session, farm)
    supply = SupplyCoordinationService(session, farm_record=farm, prediction_service=pred)
    member = MemberInformationService(session, supply, farm_record=farm)
    return {"farm": farm, "data": data, "prediction": pred, "supply": supply, "member": member, "db": session}


# --- Baseline D2 REST APIs (API-01 through API-12) ---


@router.post("/farm-observations", status_code=201)
def submit_observation(body: ObservationIn, s=Depends(services), user: Principal = Depends(require_role("FARMER"))):
    return s["data"].submit_observation(body.model_dump(mode="python"), user)


@router.post("/harvest-estimates", status_code=201)
def submit_estimate(body: EstimateIn, s=Depends(services), user: Principal = Depends(require_role("FARMER"))):
    result = s["data"].submit_estimate(body.model_dump(mode="python"), user)
    sched = get_scheduler()
    if sched is not None:
        sched.enqueue(result["farm_id"], result["crop_id"], result["harvest_period"], trigger="estimate")
    return result


@router.post("/harvest-predictions", status_code=201)
def generate_prediction(body: PredictionIn, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    return s["prediction"].generate(body.model_dump(mode="python"), user, trigger="manual")


@router.get("/harvest-predictions/{prediction_id}")
def get_prediction(prediction_id: str, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR", "FARMER"))):
    return s["prediction"].get(prediction_id, user)


@router.post("/approved-availability", status_code=201)
def approve(body: ApprovalIn, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    return s["supply"].approve(body.model_dump(), user)


@router.get("/approved-availability")
def approved(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("MEMBER", "COORDINATOR"))):
    parse_period(period)
    return s["member"].availability(period, user)


@router.post("/member-selections", status_code=201)
def selection(body: SelectionIn, s=Depends(services), user: Principal = Depends(require_role("MEMBER"))):
    return s["member"].selection(body.model_dump(), user)


@router.post("/allocation-adjustments", status_code=201)
def adjust(body: AdjustmentIn, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    return s["supply"].adjust(body.model_dump(), user)


@router.post("/actual-harvests", status_code=201)
def actual(body: ActualIn, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    farm = s["farm"]
    verify_scope(user, body.farm_id)
    farm.get_crop_context(body.farm_id, body.crop_id)
    parse_period(body.period)
    payload = body.model_dump(mode="json")
    payload["harvested_at"] = iso(body.harvested_at)
    return farm.record_actual_harvest(payload, user.user_id)


@router.post("/member-feedback", status_code=201)
def feedback(body: FeedbackIn, s=Depends(services), user: Principal = Depends(require_role("MEMBER"))):
    return s["member"].feedback(body.model_dump(), user)


@router.post("/supply-risk-assessments", status_code=201)
def risk(body: RiskIn, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    return s["supply"].assess_risk(body.model_dump(), user)


@router.get("/allocation-updates")
def updates(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("MEMBER"))):
    parse_period(period)
    return s["member"].updates(period, user)


# --- Documented D3 support, remediation & read-model endpoints ---


@router.get("/harvest-predictions")
def prediction_list(
    farm_id: str,
    period: str,
    s=Depends(services),
    user: Principal = Depends(require_role("COORDINATOR", "FARMER")),
):
    verify_scope(user, farm_id)
    parse_period(period)
    return {"items": s["prediction"].list_for_scope(farm_id=farm_id, period=period)}


@router.get("/supply-risk-assessments")
def risk_list(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    parse_period(period)
    return {
        "items": [
            r.payload
            for r in list_records(s["db"], "SupplyRiskAssessment", period=period)
            if r.farm_id in user.farm_ids
        ]
    }


@router.post("/commodity-plans", status_code=201)
def create_commodity_plan(body: CommodityPlanIn, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    return s["supply"].create_commodity_plan(body.model_dump(), user)


@router.get("/commodity-plans")
def list_commodity_plans(period: str = Query(...), crop_id: str | None = None, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    parse_period(period)
    return {"items": s["supply"].list_commodity_plans(period, crop_id=crop_id)}


def _available_periods(db: Session, fallback: str = "2026-W48") -> list[str]:
    found = {
        r.period
        for r in list_records(db, "ApprovedAvailability", limit=100)
        if r.period
    } | {
        r.period
        for r in list_records(db, "HarvestEstimate", limit=100)
        if r.period
    } | {
        r.period
        for r in list_records(db, "HarvestPrediction", limit=100)
        if r.period
    }
    found.add(fallback)
    return sorted(found, reverse=True)


def _initials(name: str) -> str:
    parts = [p for p in name.strip().split() if p]
    return "".join(p[0].upper() for p in parts[:2]) or "A"


@router.get("/catalog")
def catalog(s=Depends(services), user: Principal = Depends(current_principal)):
    all_farms = s["farm"].list_farms()
    if user.role in {"FARMER", "COORDINATOR"}:
        farms = [f for f in all_farms if f["farm_id"] in user.farm_ids]
    else:
        farms = []
    crops = s["farm"].list_crops()
    members = []
    if user.role == "COORDINATOR":
        members = [
            {
                "member_id": m["member_id"],
                "name": m.get("name", m["member_id"]),
                "package_name": m.get("package_name", "Paket Pilih" if m["eligible"] else "Paket Reguler"),
                "eligible": bool(m["eligible"]),
                "quota_kg": float(m.get("quota_kg", 0.0)),
            }
            for m in s["farm"].list_members()
        ]
    return {
        "farms": farms,
        "crops": crops,
        "periods": _available_periods(s["db"]),
        "members": members,
    }


@router.get("/farm-contexts/{farm_id}")
def farm_context(farm_id: str, s=Depends(services), user: Principal = Depends(require_role("FARMER", "COORDINATOR"))):
    verify_scope(user, farm_id)
    return {"items": s["farm"].list_active_plantings(farm_id=farm_id)}


@router.get("/farm-observations")
def observation_history(
    farm_id: str,
    crop_id: str | None = None,
    source: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    s=Depends(services),
    user: Principal = Depends(require_role("FARMER", "COORDINATOR")),
):
    verify_scope(user, farm_id)
    return {"items": s["farm"].list_observations_paginated(farm_id, crop_id=crop_id, source=source, limit=limit, offset=offset)}


@router.get("/harvest-estimates")
def estimate_history(
    farm_id: str,
    crop_id: str | None = None,
    period: str | None = None,
    s=Depends(services),
    user: Principal = Depends(require_role("FARMER", "COORDINATOR")),
):
    verify_scope(user, farm_id)
    if period:
        parse_period(period)
    return {"items": s["farm"].list_estimates(farm_id=farm_id, crop_id=crop_id, period=period)}


@router.get("/actual-harvests")
def actual_history(
    farm_id: str,
    crop_id: str | None = None,
    period: str | None = None,
    s=Depends(services),
    user: Principal = Depends(require_role("COORDINATOR")),
):
    verify_scope(user, farm_id)
    if period:
        parse_period(period)
    return {"items": [r.payload for r in list_records(s["db"], "ActualHarvest", farm_id=farm_id, crop_id=crop_id, period=period)]}


@router.get("/member-selections")
def selections(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("COORDINATOR", "MEMBER"))):
    parse_period(period)
    rows = (
        list_records(s["db"], "MemberSelection", period=period, owner_id=user.member_id)
        if user.role == "MEMBER"
        else list_records(s["db"], "MemberSelection", period=period)
    )
    return {"items": [r.payload for r in rows]}


@router.get("/allocation-adjustments")
def adjustments(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    parse_period(period)
    return {
        "items": [
            r.payload
            for r in list_records(s["db"], "AllocationAdjustment", period=period)
            if r.farm_id in user.farm_ids
        ]
    }


@router.post("/package-receipts", status_code=201)
def receipt(body: ReceiptIn, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    return s["member"].receipt(body.model_dump(), user)


@router.get("/package-receipts")
def receipt_list(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("COORDINATOR", "MEMBER"))):
    return s["member"].list_receipts(period, user)


@router.get("/member-feedback")
def feedback_list(period: str | None = None, s=Depends(services), user: Principal = Depends(require_role("COORDINATOR", "MEMBER"))):
    return s["member"].list_feedback(period, user)


@router.get("/telemetry/summary")
def telemetry_summary(
    farm_id: str,
    crop_id: str | None = None,
    s=Depends(services),
    user: Principal = Depends(require_role("COORDINATOR", "FARMER")),
):
    verify_scope(user, farm_id)
    now = datetime.now(timezone.utc)
    obs = s["farm"].list_observations_in_window(farm_id, crop_id, now - timedelta(days=7), now + timedelta(seconds=1))
    summary = build_telemetry_summary(
        obs,
        now,
        stale_seconds=settings.sensor_stale_seconds,
        offline_seconds=settings.sensor_offline_seconds,
    )
    return {"farm_id": farm_id, "crop_id": crop_id, **summary}


@router.get("/telemetry/history")
def telemetry_history(
    farm_id: str,
    range: str = Query("24h", pattern="^(1h|24h|7d)$"),
    source: str = Query("all"),
    crop_id: str | None = None,
    s=Depends(services),
    user: Principal = Depends(require_role("COORDINATOR", "FARMER")),
):
    verify_scope(user, farm_id)
    now = datetime.now(timezone.utc)
    obs = s["farm"].list_observations_in_window(farm_id, crop_id, now - timedelta(days=7), now + timedelta(seconds=1))
    return {"farm_id": farm_id, **build_telemetry_history(obs, now, range_key=range, source=source)}


@router.get("/coordinator/overview")
def coordinator_overview(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("COORDINATOR"))):
    parse_period(period)
    now = datetime.now(timezone.utc)
    farms_by_id = {f["farm_id"]: f for f in s["farm"].list_farms() if f["farm_id"] in user.farm_ids}
    crops_by_id = {c["crop_id"]: c for c in s["farm"].list_crops()}
    plantings = [p for p in s["farm"].list_active_plantings() if p["farm_id"] in user.farm_ids]
    approvals = s["supply"].approved_availability(period)
    plans = s["supply"].list_commodity_plans(period)
    risks = [r.payload for r in list_records(s["db"], "SupplyRiskAssessment", period=period) if r.farm_id in user.farm_ids]
    selections_list = [r.payload for r in list_records(s["db"], "MemberSelection", period=period)]
    adjustments_list = [r.payload for r in list_records(s["db"], "AllocationAdjustment", period=period) if r.farm_id in user.farm_ids]
    receipts_list = s["member"].list_receipts(period, user)["items"]
    feedback_list_rows = s["member"].list_feedback(period, user)["items"]

    farm_telemetry: dict[str, dict] = {}
    for fid in sorted(farms_by_id):
        obs = s["farm"].list_observations_in_window(fid, None, now - timedelta(days=7), now + timedelta(seconds=1))
        farm_telemetry[fid] = build_telemetry_summary(
            obs,
            now,
            stale_seconds=settings.sensor_stale_seconds,
            offline_seconds=settings.sensor_offline_seconds,
        )

    planting_cards: list[dict] = []
    grouped_farms: dict[str, dict] = {
        fid: {"farm": farms_by_id[fid], "telemetry": farm_telemetry[fid], "plantings": []}
        for fid in sorted(farms_by_id)
    }
    for p in plantings:
        fid, cid = p["farm_id"], p["crop_id"]
        ests = s["farm"].list_estimates(farm_id=fid, crop_id=cid, period=period)
        preds = s["prediction"].list_for_scope(farm_id=fid, crop_id=cid, period=period)
        state = s["prediction"].get_state(fid, cid, period)
        actuals = s["farm"].get_harvest_record(fid, cid, period)
        telemetry = farm_telemetry.get(fid) or build_telemetry_summary([], now)
        approval = next((a for a in approvals if a["farm_id"] == fid and a["crop_id"] == cid), None)
        card = {
            "planting": p,
            "farm": farms_by_id.get(fid, {"farm_id": fid, "name": fid}),
            "crop": crops_by_id.get(cid, {"crop_id": cid, "name": cid}),
            "latest_estimate": ests[0] if ests else None,
            "latest_prediction": preds[0] if preds else None,
            "prediction_history": preds[:14],
            "prediction_state": state,
            "approval": approval,
            "actual_harvest": actuals[0] if actuals else None,
            "telemetry": telemetry,
        }
        planting_cards.append(card)
        if fid in grouped_farms:
            grouped_farms[fid]["plantings"].append(card)

    avl_by_id = {a["availability_id"]: a for a in approvals}
    has_actual_shortage = any(
        c["actual_harvest"]
        and c["approval"]
        and c["actual_harvest"]["actual_quantity_kg"] < sum(a["quantity_kg"] for a in c["approval"].get("member_allocations", []))
        and not any(adj.get("actual_harvest_id") == c["actual_harvest"]["actual_harvest_id"] for adj in adjustments_list)
        for c in planting_cards
    )
    members_raw = s["farm"].list_members()
    member_rows: list[dict] = []
    for m in members_raw:
        mid = m["member_id"]
        mname = m.get("name", mid)
        pkg = m.get("package_name", "Paket Pilih" if m["eligible"] else "Paket Reguler")
        sel = next((x for x in selections_list if x["member_id"] == mid), None)
        req_items = [
            {
                "availability_id": it["availability_id"],
                "crop_id": avl_by_id[it["availability_id"]]["crop_id"] if it["availability_id"] in avl_by_id else None,
                "farm_id": avl_by_id[it["availability_id"]]["farm_id"] if it["availability_id"] in avl_by_id else None,
                "quantity_kg": float(it["quantity_kg"]),
            }
            for it in (sel["items"] if sel else [])
        ]
        req_total = round(sum(it["quantity_kg"] for it in req_items), 3)
        alloc_items: list[dict] = []
        for avl in approvals:
            for al in avl.get("member_allocations", []):
                if al["member_id"] == mid:
                    alloc_items.append(
                        {
                            "availability_id": avl["availability_id"],
                            "crop_id": avl["crop_id"],
                            "farm_id": avl["farm_id"],
                            "quantity_kg": float(al["quantity_kg"]),
                        }
                    )
        alloc_total = round(sum(it["quantity_kg"] for it in alloc_items), 3)
        has_final_alloc = any(it["quantity_kg"] > 0 for it in alloc_items)
        rcpt = next((r for r in receipts_list if r["member_id"] == mid and r.get("received")), None)
        fb = next((f for f in feedback_list_rows if f["member_id"] == mid), None)

        if rcpt and has_final_alloc:
            lstatus = "Diterima"
        elif has_actual_shortage and has_final_alloc:
            lstatus = "Perlu penyesuaian"
        elif has_final_alloc:
            lstatus = "Siap didistribusikan"
        elif m["eligible"] and not sel:
            lstatus = "Belum memilih"
        else:
            lstatus = "Menunggu alokasi"

        member_rows.append(
            {
                "member_id": mid,
                "name": mname,
                "initials": _initials(mname),
                "package_name": pkg,
                "eligible": bool(m["eligible"]),
                "quota_kg": float(m.get("quota_kg", 0.0)),
                "requested_items": req_items,
                "requested_total_kg": req_total if sel else None,
                "allocated_items": alloc_items,
                "allocated_total_kg": alloc_total if alloc_items else None,
                "receipt_confirmed": bool(rcpt),
                "feedback_submitted": bool(fb),
                "lifecycle_status": lstatus,
            }
        )

    demo_mode = any(bool(f.get("synthetic") or f.get("demo_scenario")) for f in farms_by_id.values())
    return {
        "period": period,
        "available_periods": _available_periods(s["db"], period),
        "demo_mode": demo_mode,
        "farms": [grouped_farms[fid] for fid in sorted(grouped_farms)],
        "plantings": planting_cards,
        "commodity_plans": plans,
        "risks": risks,
        "approvals": approvals,
        "selections": selections_list,
        "adjustments": adjustments_list,
        "receipts": receipts_list,
        "feedback": feedback_list_rows,
        "members": [
            {
                "member_id": m["member_id"],
                "name": m.get("name", m["member_id"]),
                "package_name": m.get("package_name", "Paket Pilih" if m["eligible"] else "Paket Reguler"),
                "eligible": bool(m["eligible"]),
                "quota_kg": float(m.get("quota_kg", 0.0)),
            }
            for m in members_raw
        ],
        "member_rows": member_rows,
    }


@router.get("/farmer/overview")
def farmer_overview(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("FARMER"))):
    parse_period(period)
    now = datetime.now(timezone.utc)
    farms_by_id = {f["farm_id"]: f for f in s["farm"].list_farms() if f["farm_id"] in user.farm_ids}
    crops_by_id = {c["crop_id"]: c for c in s["farm"].list_crops()}
    plantings = [p for p in s["farm"].list_active_plantings() if p["farm_id"] in user.farm_ids]
    farm_telemetry: dict[str, dict] = {}
    for fid in sorted(farms_by_id):
        obs = s["farm"].list_observations_in_window(fid, None, now - timedelta(days=7), now + timedelta(seconds=1))
        farm_telemetry[fid] = build_telemetry_summary(
            obs,
            now,
            stale_seconds=settings.sensor_stale_seconds,
            offline_seconds=settings.sensor_offline_seconds,
        )
    items: list[dict] = []
    grouped: dict[str, dict] = {
        fid: {"farm": farms_by_id[fid], "telemetry": farm_telemetry[fid], "plantings": []}
        for fid in sorted(farms_by_id)
    }
    for p in plantings:
        fid, cid = p["farm_id"], p["crop_id"]
        ests = s["farm"].list_estimates(farm_id=fid, crop_id=cid, period=period)
        preds = s["prediction"].list_for_scope(farm_id=fid, crop_id=cid, period=period)
        telemetry = farm_telemetry.get(fid) or build_telemetry_summary([], now)
        card = {
            "planting": p,
            "farm": farms_by_id.get(fid, {"farm_id": fid, "name": fid}),
            "crop": crops_by_id.get(cid, {"crop_id": cid, "name": cid}),
            "latest_estimate": ests[0] if ests else None,
            "estimates": ests,
            "latest_prediction": preds[0] if preds else None,
            "telemetry": telemetry,
        }
        items.append(card)
        if fid in grouped:
            grouped[fid]["plantings"].append(card)
    recent_obs = []
    for fid in sorted(user.farm_ids):
        recent_obs.extend(s["farm"].list_observations_paginated(fid, limit=30))
    demo_mode = any(bool(f.get("synthetic") or f.get("demo_scenario")) for f in farms_by_id.values())
    return {
        "period": period,
        "available_periods": _available_periods(s["db"], period),
        "demo_mode": demo_mode,
        "farms": [grouped[fid] for fid in sorted(grouped)],
        "plantings": items,
        "recent_observations": recent_obs[:30],
    }


@router.get("/member/overview")
def member_overview(period: str = Query(...), s=Depends(services), user: Principal = Depends(require_role("MEMBER"))):
    parse_period(period)
    member = s["farm"].get_member(user.member_id) or {
        "member_id": user.member_id,
        "name": user.name,
        "package_name": "Paket Pilih" if user.can_select else "Paket Reguler",
        "eligible": user.can_select,
        "quota_kg": 2.0 if user.can_select else 0.0,
    }
    availability = s["member"].availability(period, user)["items"]
    own_selections = [r.payload for r in list_records(s["db"], "MemberSelection", period=period, owner_id=user.member_id)]
    all_own_selections = [r.payload for r in list_records(s["db"], "MemberSelection", owner_id=user.member_id)]
    updates_list = s["member"].updates(period, user)["items"]
    receipts = s["member"].list_receipts(period, user)["items"]
    own_feedback = s["member"].list_feedback(period, user)["items"]
    all_own_feedback = s["member"].list_feedback(None, user)["items"]

    has_alloc = any(a.get("own_allocation_kg", 0) > 0 for a in availability) or len(updates_list) > 0
    receipt_confirmed = bool(receipts and receipts[0].get("received"))
    if own_feedback:
        progress_step = "feedback_sent"
    elif receipt_confirmed:
        progress_step = "received"
    elif has_alloc:
        progress_step = "allocated"
    elif own_selections:
        progress_step = "selected"
    elif availability:
        progress_step = "published"
    else:
        progress_step = "waiting_publication"

    all_own_receipts = [r.payload for r in list_records(s["db"], "Receipt", owner_id=user.member_id)]
    all_own_adjustments = [
        r.payload
        for r in list_records(s["db"], "AllocationAdjustment")
        if any(a.get("member_id") == user.member_id for a in r.payload.get("member_allocations", []))
    ]
    package_periods = sorted(
        {period}
        | {x["period"] for x in all_own_selections if x.get("period")}
        | {x["period"] for x in all_own_receipts if x.get("period")}
        | {x["period"] for x in all_own_feedback if x.get("period")}
        | {x["period"] for x in all_own_adjustments if x.get("period")},
        reverse=True,
    )
    pkg_name = member.get("package_name", "Paket Pilih" if member.get("eligible") else "Paket Reguler")
    packages: list[dict] = []
    for p_str in package_periods:
        p_avls = s["member"].availability(p_str, user)["items"]
        avl_crop_map = {a["availability_id"]: a["crop_id"] for a in p_avls}
        p_sel = next((x for x in all_own_selections if x["period"] == p_str), None)
        req_items = [
            {"crop_id": avl_crop_map.get(it["availability_id"], it["availability_id"]), "quantity_kg": float(it["quantity_kg"])}
            for it in (p_sel["items"] if p_sel else [])
        ]
        alloc_items = [
            {"crop_id": a["crop_id"], "quantity_kg": float(a["own_allocation_kg"])}
            for a in p_avls
            if a.get("own_allocation_kg", 0) > 0
        ]
        p_rcpt = next((r for r in all_own_receipts if r["period"] == p_str and r.get("received")), None)
        p_fb = next((f for f in all_own_feedback if f["period"] == p_str), None)
        total_kg = round(sum(i["quantity_kg"] for i in (alloc_items or req_items)), 2)
        if p_fb:
            p_status = "Ulasan terkirim"
        elif p_rcpt:
            p_status = "Paket diterima"
        elif alloc_items:
            p_status = "Paket sedang disiapkan"
        elif p_sel:
            p_status = "Pilihan dikonfirmasi"
        elif p_avls:
            p_status = "Pilihan sayuran dibuka" if member.get("eligible") else "Penawaran dibuka"
        else:
            p_status = "Pilihan sayuran minggu ini belum dibuka"

        packages.append(
            {
                "period": p_str,
                "package_name": pkg_name,
                "status_label": p_status,
                "requested_items": req_items,
                "allocated_items": alloc_items,
                "total_kg": total_kg,
                "receipt_confirmed": bool(p_rcpt),
                "received_at": p_rcpt.get("confirmed_at") if p_rcpt else None,
                "feedback": (
                    {"feedback_id": p_fb["feedback_id"], "comment": p_fb["comment"], "recorded_at": p_fb["recorded_at"]}
                    if p_fb
                    else None
                ),
            }
        )

    demo_mode = bool(member.get("synthetic") or member.get("demo_scenario"))
    return {
        "period": period,
        "available_periods": _available_periods(s["db"], period),
        "demo_mode": demo_mode,
        "progress_step": progress_step,
        "member": {
            "member_id": member["member_id"],
            "name": member.get("name", user.name),
            "package_name": pkg_name,
            "eligible": bool(member.get("eligible", user.can_select)),
            "quota_kg": float(member.get("quota_kg", 0.0)),
        },
        "availability": availability,
        "selection": own_selections[0] if own_selections else None,
        "updates": updates_list,
        "receipt": receipts[0] if receipts else None,
        "feedback": own_feedback[0] if own_feedback else None,
        "packages": packages,
        "history": {
            "selections": all_own_selections,
            "feedback": all_own_feedback,
        },
    }
