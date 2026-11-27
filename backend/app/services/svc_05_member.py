from __future__ import annotations
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from ..core import Principal, error, list_records, record, save
from .common import audit, new_id, parse_period, require


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _next_period(period: str) -> str:
    parse_period(period)
    year, week = period.split("-W")
    monday = date.fromisocalendar(int(year), int(week), 1)
    nxt = (monday + timedelta(days=7)).isocalendar()
    return f"{nxt.year}-W{nxt.week:02d}"


class MemberInformationService:
    def __init__(self, session: Session, supply, farm_record=None):
        self.db = session
        self.supply = supply
        self.farm_record = farm_record

    def _get_member(self, member_id: str) -> dict | None:
        if self.farm_record is not None:
            return self.farm_record.get_member(member_id)
        row = record(self.db, "Member", member_id)
        return row.payload if row else None

    def availability(self, period: str, principal: Principal | None = None) -> dict:
        # B03: Members only ever receive the sanitized member-safe projection
        if principal is None or principal.role == "MEMBER":
            mid = principal.member_id if principal else None
            return {"items": self.supply.member_approved_availability(period, member_id=mid)}
        return {"items": self.supply.approved_availability(period)}

    def effective_package(self, member: dict, period: str) -> dict:
        parse_period(period)
        overrides = member.get("subscription_overrides") or {}
        matching = [
            (eff_p, val)
            for eff_p, val in overrides.items()
            if eff_p <= period and isinstance(val, dict) and val.get("target_package") in {"Paket Reguler", "Paket Custom"}
        ]
        if matching:
            _, latest = sorted(matching, key=lambda x: (x[0], x[1].get("updated_at", "")))[-1]
            elig = latest["target_package"] == "Paket Custom"
            return {
                "package_name": latest["target_package"],
                "eligible": elig,
                "quota_kg": 2.0 if elig else 0.0,
            }
        elig = bool(member.get("eligible", False))
        return {
            "package_name": member.get("package_name", "Paket Custom" if elig else "Paket Reguler"),
            "eligible": elig,
            "quota_kg": float(member.get("quota_kg", 2.0 if elig else 0.0)),
        }

    def get_next_period_subscription(self, member_id: str, period: str) -> dict | None:
        nxt = _next_period(period)
        member = self._get_member(member_id)
        if not member:
            return None
        val = (member.get("subscription_overrides") or {}).get(nxt)
        if not isinstance(val, dict):
            return None
        return {
            "effective_period": nxt,
            "package_name": val["target_package"],
            "eligible": bool(val["eligible"]),
            "quota_kg": float(val["quota_kg"]),
            "updated_at": val.get("updated_at"),
        }

    def schedule_subscription_change(self, data: dict, principal: Principal) -> dict:
        if principal.role != "MEMBER" or not principal.member_id:
            error("FORBIDDEN", "Member role required", 403)
        row = record(self.db, "Member", principal.member_id)
        require(row, "MEMBER_NOT_FOUND", "Member does not exist")
        effective_period = _next_period(data["period"])
        target_pkg = data["target_package"]
        elig = target_pkg == "Paket Custom"
        quota = 2.0 if elig else 0.0
        updated_at = _now_iso()
        overrides = dict(row.payload.get("subscription_overrides") or {})
        overrides[effective_period] = {
            "target_package": target_pkg,
            "eligible": elig,
            "quota_kg": quota,
            "requested_from_period": data["period"],
            "updated_at": updated_at,
        }
        row.payload = {**row.payload, "subscription_overrides": overrides}
        self.db.flush()
        audit(self.db, principal.user_id, "scheduleSubscriptionChange", principal.member_id, {"target_package": target_pkg, "effective_period": effective_period})
        return {
            "effective_period": effective_period,
            "package_name": target_pkg,
            "eligible": elig,
            "quota_kg": quota,
            "updated_at": updated_at,
        }

    def selection(self, data: dict, principal: Principal) -> dict:
        parse_period(data["period"])
        member = self._get_member(principal.member_id)
        require(member)
        eff = self.effective_package(member, data["period"])
        if not eff["eligible"]:
            error("PACKAGE_INELIGIBLE", "Member package does not allow selection", 403)

        # B02: Reject duplicate availability_id lines before stock/quota math
        raw_items = data["items"]
        seen_ids: set[str] = set()
        for item in raw_items:
            aid = item["availability_id"]
            if aid in seen_ids:
                error("DUPLICATE_AVAILABILITY_ITEM", "Each availability_id may appear only once per selection", 422)
            seen_ids.add(aid)

        member = self._get_member(principal.member_id)
        require(member)

        # Deterministic lock order across referenced availabilities to serialize concurrent reservations
        accepted: list[dict] = []
        total = Decimal(0)
        for item in sorted(raw_items, key=lambda x: x["availability_id"]):
            row = self.supply.lock_availability_for_selection(item["availability_id"])
            p = row.payload
            if p.get("status") != "APPROVED":
                error("AVAILABILITY_NOT_APPROVED", "Availability is not approved", 422)
            if p["period"] != data["period"]:
                error("PERIOD_MISMATCH", "Availability is for another period", 422)
            if row.version != item["availability_version"]:
                error("VERSION_CONFLICT", "Availability version is stale", 409)
            q = Decimal(str(item["quantity_kg"]))
            if q <= 0:
                error("INVALID_QUANTITY", "Selection quantity must be positive", 422)
            total += q
            if q > Decimal(str(p["approved_quantity_kg"])):
                error("STOCK_LIMIT", "Selection exceeds approved stock", 422)

            existing = Decimal(0)
            for sel in list_records(self.db, "MemberSelection", period=data["period"]):
                if sel.owner_id == principal.member_id:
                    error("SELECTION_EXISTS", "Selection already submitted for this period", 409)
                for selected in sel.payload.get("items", []):
                    if selected["availability_id"] == row.id:
                        existing += Decimal(str(selected["quantity_kg"]))
            if existing + q > Decimal(str(p["approved_quantity_kg"])):
                error("STOCK_LIMIT", "Selections exceed remaining approved stock", 409)
            accepted.append(item)

        if total > Decimal(str(eff["quota_kg"])) or total > Decimal(str(member["max_stock_kg"])):
            error("QUOTA_EXCEEDED", "Selection exceeds package quota or stock limit", 422)

        payload = {
            "selection_id": new_id("SEL"),
            "period": data["period"],
            "items": accepted,
            "member_id": principal.member_id,
            "status": "RECORDED",
            "recorded_at": _now_iso(),
        }
        try:
            save(
                self.db,
                "MemberSelection",
                payload,
                id=payload["selection_id"],
                period=data["period"],
                owner_id=principal.member_id,
            )
        except IntegrityError:
            self.db.rollback()
            error("SELECTION_EXISTS", "Selection already submitted for this period", 409)
        audit(self.db, principal.user_id, "submitMemberSelection", payload["selection_id"])
        return payload

    def updates(self, period: str, principal: Principal) -> dict:
        parse_period(period)
        result: list[dict] = []
        for change in self.supply.list_adjustments(period):
            # B05: Prefer member_updates (includes removed/zero-quantity notices), fallback to member_allocations
            entries = change.get("member_updates") or change.get("member_allocations", [])
            for a in entries:
                if a["member_id"] == principal.member_id:
                    result.append(
                        {
                            "adjustment_id": change["adjustment_id"],
                            "availability_id": change["availability_id"],
                            "farm_id": change.get("farm_id"),
                            "crop_id": change.get("crop_id"),
                            "period": period,
                            "quantity_kg": a["quantity_kg"],
                            "previous_quantity_kg": a.get("previous_quantity_kg"),
                            "removed": bool(a.get("removed", False)),
                            "reason": change["reason"],
                            "version": change["version"],
                            "approved_at": change["approved_at"],
                        }
                    )
        return {"items": result}

    def receipt(self, data: dict, principal: Principal) -> dict:
        if principal.role != "COORDINATOR":
            error("FORBIDDEN", "Coordinator role required", 403)
        member = self._get_member(data["member_id"])
        require(member, "MEMBER_NOT_FOUND", "Member does not exist")
        parse_period(data["period"])
        if data.get("confirmed", True):
            avls = self.supply.approved_availability(data["period"])
            has_final_allocation = any(
                any(
                    a.get("member_id") == data["member_id"] and float(a.get("quantity_kg", 0)) > 0
                    for a in avl.get("member_allocations", [])
                )
                for avl in avls
            )
            if not has_final_allocation:
                error(
                    "ALLOCATION_REQUIRED",
                    "Package receipt can only be confirmed after a final allocation is recorded for this member",
                    409,
                )
        existing = list_records(self.db, "Receipt", period=data["period"], owner_id=data["member_id"])
        if existing:
            row = existing[0]
            updated = {
                **row.payload,
                "received": bool(data["confirmed"]),
                "confirmed_by": principal.user_id,
                "confirmed_at": _now_iso(),
            }
            row.payload = updated
            self.db.flush()
            audit(self.db, principal.user_id, "confirmPackageReceipt", row.id, {"confirmed": bool(data["confirmed"])})
            return updated
        rid = new_id("RCT")
        p = {
            "receipt_id": rid,
            "member_id": data["member_id"],
            "period": data["period"],
            "received": bool(data["confirmed"]),
            "confirmed_by": principal.user_id,
            "confirmed_at": _now_iso(),
        }
        save(self.db, "Receipt", p, id=rid, period=data["period"], owner_id=data["member_id"])
        audit(self.db, principal.user_id, "confirmPackageReceipt", rid, {"confirmed": bool(data["confirmed"])})
        return p

    def list_receipts(self, period: str, principal: Principal) -> dict:
        parse_period(period)
        if principal.role == "MEMBER":
            rows = list_records(self.db, "Receipt", period=period, owner_id=principal.member_id)
        else:
            rows = list_records(self.db, "Receipt", period=period)
        return {"items": [r.payload for r in rows]}

    def feedback(self, data: dict, principal: Principal) -> dict:
        parse_period(data["period"])
        receipts = list_records(self.db, "Receipt", period=data["period"], owner_id=principal.member_id)
        latest_receipt = receipts[0] if receipts else None
        if latest_receipt is None or not latest_receipt.payload.get("received"):
            error("PACKAGE_NOT_RECEIVED", "Feedback requires confirmed package receipt", 409)
        if list_records(self.db, "MemberFeedback", period=data["period"], owner_id=principal.member_id):
            error("FEEDBACK_EXISTS", "Feedback already exists for this period", 409)
        p = {
            "feedback_id": new_id("FDB"),
            "period": data["period"],
            "comment": data["comment"],
            "member_id": principal.member_id,
            "status": "RECORDED",
            "recorded_at": _now_iso(),
        }
        save(self.db, "MemberFeedback", p, id=p["feedback_id"], period=data["period"], owner_id=principal.member_id)
        audit(self.db, principal.user_id, "submitFeedback", p["feedback_id"])
        return p

    def list_feedback(self, period: str | None, principal: Principal) -> dict:
        if period:
            parse_period(period)
        if principal.role == "MEMBER":
            rows = list_records(self.db, "MemberFeedback", period=period, owner_id=principal.member_id)
        else:
            rows = list_records(self.db, "MemberFeedback", period=period)
        return {"items": [r.payload for r in rows]}
