from __future__ import annotations
from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from ..core import Principal, Record, error, list_records, record, save, update_versioned, verify_scope
from .common import audit, new_id, parse_period, require


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class SupplyCoordinationService:
    def __init__(self, session: Session, farm_record=None, prediction_service=None):
        self.db = session
        self.farm_record = farm_record
        self.prediction_service = prediction_service

    def _reserved_by_availability(self, period: str) -> dict[str, Decimal]:
        reserved: dict[str, Decimal] = {}
        for sel in list_records(self.db, "MemberSelection", period=period):
            for item in sel.payload.get("items", []):
                aid = item["availability_id"]
                reserved[aid] = reserved.get(aid, Decimal(0)) + Decimal(str(item["quantity_kg"]))
        return reserved

    def _get_prediction(self, prediction_id: str) -> dict | None:
        if self.prediction_service is not None:
            return self.prediction_service.get_by_id(prediction_id)
        row = record(self.db, "HarvestPrediction", prediction_id)
        return row.payload if row else None

    def _get_estimate(self, estimate_id: str) -> dict | None:
        if self.farm_record is not None:
            return self.farm_record.get_estimate(estimate_id)
        row = record(self.db, "HarvestEstimate", estimate_id)
        return row.payload if row else None

    def _get_actual(self, actual_id: str) -> dict | None:
        if self.farm_record is not None:
            return self.farm_record.get_actual_by_id(actual_id)
        row = record(self.db, "ActualHarvest", actual_id)
        return row.payload if row else None

    def _member_exists(self, member_id: str) -> bool:
        if self.farm_record is not None:
            return self.farm_record.get_member(member_id) is not None
        return record(self.db, "Member", member_id) is not None

    def assess_risk(self, data: dict, principal: Principal) -> dict:
        pred = self._get_prediction(data["prediction_id"])
        require(pred)
        verify_scope(principal, pred["farm_id"])
        prediction = Decimal(str(pred["predicted_quantity_kg"]))
        demand = Decimal(str(data["planned_demand_kg"]))
        gap = max(Decimal(0), demand - prediction)
        status = "SHORTAGE_POSSIBLE" if gap > 0 else "NO_SHORTAGE_INDICATED"
        payload = {
            "assessment_id": new_id("RISK"),
            "prediction_id": data["prediction_id"],
            "farm_id": pred["farm_id"],
            "crop_id": pred["crop_id"],
            "period": pred["target_period"],
            "predicted_quantity_kg": float(prediction),
            "planned_demand_kg": float(demand),
            "shortage_gap_kg": float(gap),
            "status": status,
            "assessed_by": principal.user_id,
            "assessed_at": _now_iso(),
        }
        save(
            self.db,
            "SupplyRiskAssessment",
            payload,
            id=payload["assessment_id"],
            farm_id=pred["farm_id"],
            crop_id=pred["crop_id"],
            period=pred["target_period"],
            owner_id=principal.user_id,
        )
        audit(self.db, principal.user_id, "assessSupplyRisk", payload["assessment_id"])
        return payload

    def _is_plan_stale(self, plan: dict) -> bool:
        crop_id = plan["crop_id"]
        period = plan["period"]
        for item in plan.get("items", []):
            farm_id = item["farm_id"]
            if item["basis_type"] == "PREDICTION" and self.prediction_service is not None:
                latest = self.prediction_service.latest_for_scope(farm_id, crop_id, period)
                if latest and latest["prediction_id"] != item["basis_id"]:
                    return True
            elif item["basis_type"] == "MANUAL_ESTIMATE" and self.farm_record is not None:
                ests = self.farm_record.list_estimates(farm_id=farm_id, crop_id=crop_id, period=period)
                if ests and ests[0]["estimate_id"] != item["basis_id"]:
                    return True
        return False

    def create_commodity_plan(self, data: dict, principal: Principal) -> dict:
        parse_period(data["period"])
        crop_id = data["crop_id"]
        period = data["period"]
        demand = Decimal(str(data["planned_demand_kg"]))
        resolved_items: list[dict] = []
        seen_farms: set[str] = set()

        if data.get("items"):
            for entry in data["items"]:
                fid = entry["farm_id"]
                verify_scope(principal, fid)
                if fid in seen_farms:
                    error("DUPLICATE_FARM_IN_PLAN", "Each farm/planting may appear once in a commodity plan", 422)
                seen_farms.add(fid)
                if entry["basis_type"] == "PREDICTION":
                    basis = self._get_prediction(entry["basis_id"])
                    require(basis, "BASIS_NOT_FOUND", "Prediction basis not found")
                    if (basis["farm_id"], basis["crop_id"], basis["target_period"]) != (fid, crop_id, period):
                        error("BASIS_SCOPE_MISMATCH", "Prediction does not match farm, crop and period", 422)
                    qty = Decimal(str(basis["predicted_quantity_kg"]))
                else:
                    basis = self._get_estimate(entry["basis_id"])
                    require(basis, "BASIS_NOT_FOUND", "Estimate basis not found")
                    if (basis["farm_id"], basis["crop_id"], basis["harvest_period"]) != (fid, crop_id, period):
                        error("BASIS_SCOPE_MISMATCH", "Estimate does not match farm, crop and period", 422)
                    qty = Decimal(str(basis["estimated_quantity_kg"]))
                resolved_items.append(
                    {
                        "farm_id": fid,
                        "basis_type": entry["basis_type"],
                        "basis_id": entry["basis_id"],
                        "quantity_kg": float(qty),
                    }
                )
        else:
            # Automatically collect latest basis per active planting for (crop_id, period)
            plantings = self.farm_record.list_active_plantings(crop_id=crop_id) if self.farm_record else []
            for p in plantings:
                fid = p["farm_id"]
                if fid in seen_farms:
                    continue
                seen_farms.add(fid)
                pred = self.prediction_service.latest_for_scope(fid, crop_id, period) if self.prediction_service else None
                if pred:
                    resolved_items.append(
                        {
                            "farm_id": fid,
                            "basis_type": "PREDICTION",
                            "basis_id": pred["prediction_id"],
                            "quantity_kg": float(pred["predicted_quantity_kg"]),
                        }
                    )
                    continue
                ests = self.farm_record.list_estimates(farm_id=fid, crop_id=crop_id, period=period) if self.farm_record else []
                if ests:
                    resolved_items.append(
                        {
                            "farm_id": fid,
                            "basis_type": "MANUAL_ESTIMATE",
                            "basis_id": ests[0]["estimate_id"],
                            "quantity_kg": float(ests[0]["estimated_quantity_kg"]),
                        }
                    )

        total_supply = sum((Decimal(str(it["quantity_kg"])) for it in resolved_items), Decimal(0))
        gap = max(Decimal(0), demand - total_supply)
        status = "SHORTAGE_POSSIBLE" if gap > 0 else "NO_SHORTAGE_INDICATED"
        basis_types = {it["basis_type"] for it in resolved_items}
        if not resolved_items:
            coverage_status = "incomplete"
        elif basis_types == {"PREDICTION"}:
            coverage_status = "complete_ai"
        elif basis_types == {"MANUAL_ESTIMATE"}:
            coverage_status = "manual_fallback"
        else:
            coverage_status = "mixed"

        prior = list_records(self.db, "CommodityPlan", crop_id=crop_id, period=period)
        plan_version = len(prior) + 1
        plan_id = new_id("PLAN")
        payload = {
            "plan_id": plan_id,
            "crop_id": crop_id,
            "period": period,
            "plan_version": plan_version,
            "planned_demand_kg": float(demand),
            "total_supply_kg": float(total_supply),
            "shortage_gap_kg": float(gap),
            "status": status,
            "coverage_status": coverage_status,
            "items": resolved_items,
            "review_note": data.get("review_note", ""),
            "verified_with_farmer": bool(data.get("verified_with_farmer", False)),
            "review_outcome": data.get("review_outcome", "CONFIRMED"),
            "farmer_verification_status": data.get(
                "farmer_verification_status",
                "CONFIRMED" if data.get("verified_with_farmer") else "UNCONFIRMED",
            ),
            "is_stale": False,
            "reviewed_by": principal.user_id,
            "reviewed_at": _now_iso(),
        }
        save(
            self.db,
            "CommodityPlan",
            payload,
            id=plan_id,
            crop_id=crop_id,
            period=period,
            owner_id=principal.user_id,
            version=plan_version,
        )
        audit(self.db, principal.user_id, "reviewCommodityPlan", plan_id, {"crop_id": crop_id, "period": period})
        return payload

    def list_commodity_plans(self, period: str, crop_id: str | None = None) -> list[dict]:
        parse_period(period)
        rows = list_records(self.db, "CommodityPlan", period=period, crop_id=crop_id)
        seen_crops: set[str] = set()
        latest: list[dict] = []
        for r in rows:
            if r.crop_id in seen_crops:
                continue
            seen_crops.add(r.crop_id)
            p = dict(r.payload)
            p["is_stale"] = self._is_plan_stale(p)
            latest.append(p)
        return latest

    def _find_valid_review_for_prediction(self, pred: dict, data: dict) -> tuple[str | None, str | None]:
        # Check explicit or latest SupplyRiskAssessment for this exact prediction_id
        if data.get("assessment_id"):
            row = record(self.db, "SupplyRiskAssessment", data["assessment_id"])
            if row is None or row.payload.get("prediction_id") != pred["prediction_id"]:
                error("ASSESSMENT_MISMATCH", "Specified risk assessment does not match this prediction", 422)
            return row.id, None

        if data.get("commodity_plan_id"):
            prow = record(self.db, "CommodityPlan", data["commodity_plan_id"])
            if prow is None:
                error("PLAN_NOT_FOUND", "Specified commodity plan was not found", 404)
            if self._is_plan_stale(prow.payload):
                error("STALE_PLAN_REVIEW", "Commodity plan review is stale; re-review before approving", 409)
            if prow.payload.get("review_outcome") in {"WAITING_FARMER", "NEEDS_ADJUSTMENT"}:
                error(
                    "VERIFICATION_PENDING",
                    "Coordinator review is still waiting for farmer confirmation or supply adjustment",
                    422,
                )
            matched = any(
                it["farm_id"] == pred["farm_id"]
                and it["basis_type"] == "PREDICTION"
                and it["basis_id"] == pred["prediction_id"]
                for it in prow.payload.get("items", [])
            )
            if not matched or prow.crop_id != pred["crop_id"] or prow.period != pred["target_period"]:
                error("PLAN_MISMATCH", "Commodity plan does not cover this prediction", 422)
            return None, prow.id

        # Implicit lookup: latest scoped SupplyRiskAssessment for this exact prediction_id
        assessments = list_records(
            self.db, "SupplyRiskAssessment", farm_id=pred["farm_id"], crop_id=pred["crop_id"], period=pred["target_period"]
        )
        for a in assessments:
            if a.payload.get("prediction_id") == pred["prediction_id"]:
                return a.id, None

        # Or latest non-stale CommodityPlan referencing this exact prediction_id
        for plan in self.list_commodity_plans(pred["target_period"], crop_id=pred["crop_id"]):
            if not plan["is_stale"] and any(
                it["farm_id"] == pred["farm_id"]
                and it["basis_type"] == "PREDICTION"
                and it["basis_id"] == pred["prediction_id"]
                for it in plan.get("items", [])
            ):
                return None, plan["plan_id"]

        error(
            "REVIEW_REQUIRED",
            "Prediction must be assessed for supply risk or reviewed in a current commodity plan before approval",
            422,
        )
        return None, None

    def approve(self, data: dict, principal: Principal) -> dict:
        parse_period(data["period"])
        verify_scope(principal, data["farm_id"])
        assessment_id: str | None = None
        commodity_plan_id: str | None = None

        if data["basis_type"] == "PREDICTION":
            basis = self._get_prediction(data["basis_id"])
            require(basis, "BASIS_NOT_FOUND", "Approval basis was not found")
            basis_period = basis["target_period"]
            qty = basis.get("predicted_quantity_kg")
            if (basis["farm_id"], basis["crop_id"], basis_period) != (data["farm_id"], data["crop_id"], data["period"]):
                error("BASIS_SCOPE_MISMATCH", "Approval basis does not match farm, crop and period", 422)
            assessment_id, commodity_plan_id = self._find_valid_review_for_prediction(basis, data)
        else:
            basis = self._get_estimate(data["basis_id"])
            require(basis, "BASIS_NOT_FOUND", "Approval basis was not found")
            basis_period = basis["harvest_period"]
            qty = basis.get("estimated_quantity_kg")
            if (basis["farm_id"], basis["crop_id"], basis_period) != (data["farm_id"], data["crop_id"], data["period"]):
                error("BASIS_SCOPE_MISMATCH", "Approval basis does not match farm, crop and period", 422)

        if qty is None or abs(float(qty) - data["approved_quantity_kg"]) > 1e-6:
            error("BASIS_QUANTITY_MISMATCH", "Approved quantity must match selected basis", 422)
        if list_records(self.db, "ApprovedAvailability", farm_id=data["farm_id"], crop_id=data["crop_id"], period=data["period"]):
            error("AVAILABILITY_EXISTS", "An approved availability already exists for this farm, crop and period", 409)

        payload = {
            "farm_id": data["farm_id"],
            "crop_id": data["crop_id"],
            "period": data["period"],
            "basis_type": data["basis_type"],
            "basis_id": data["basis_id"],
            "approved_quantity_kg": float(data["approved_quantity_kg"]),
            "initial_approved_quantity_kg": float(data["approved_quantity_kg"]),
            "approval_note": data["approval_note"],
            "assessment_id": assessment_id,
            "commodity_plan_id": commodity_plan_id,
            "availability_id": new_id("AVL"),
            "status": "APPROVED",
            "version": 1,
            "approved_by": principal.user_id,
            "approved_at": _now_iso(),
            "member_allocations": [],
            "allocation_changes": [],
        }
        try:
            save(
                self.db,
                "ApprovedAvailability",
                payload,
                id=payload["availability_id"],
                farm_id=data["farm_id"],
                crop_id=data["crop_id"],
                period=data["period"],
                owner_id=principal.user_id,
            )
        except IntegrityError:
            self.db.rollback()
            error("AVAILABILITY_EXISTS", "An approved availability already exists for this farm, crop and period", 409)
        audit(self.db, principal.user_id, "approveAvailability", payload["availability_id"])
        return payload

    def get_availability(self, availability_id: str) -> Record:
        row = record(self.db, "ApprovedAvailability", availability_id)
        require(row)
        return row

    def lock_availability_for_selection(self, availability_id: str) -> Record:
        row = self.db.scalar(
            select(Record)
            .where(Record.id == availability_id, Record.kind == "ApprovedAvailability")
            .with_for_update()
        )
        require(row)
        return row

    def approved_availability(self, period: str) -> list[dict]:
        parse_period(period)
        reserved = self._reserved_by_availability(period)
        items: list[dict] = []
        for r in list_records(self.db, "ApprovedAvailability", period=period):
            p = dict(r.payload)
            used = reserved.get(r.id, Decimal(0))
            rem = max(Decimal(0), Decimal(str(p["approved_quantity_kg"])) - used)
            p["remaining_quantity_kg"] = float(rem)
            items.append(p)
        return items

    def member_approved_availability(self, period: str, member_id: str | None = None) -> list[dict]:
        """B03: Strictly member-safe projection — never exposes other members' allocations or internal notes."""
        parse_period(period)
        reserved = self._reserved_by_availability(period)
        items: list[dict] = []
        for r in list_records(self.db, "ApprovedAvailability", period=period):
            p = r.payload
            used = reserved.get(r.id, Decimal(0))
            rem = max(Decimal(0), Decimal(str(p["approved_quantity_kg"])) - used)
            own_alloc = None
            if member_id:
                for alloc in p.get("member_allocations", []):
                    if alloc.get("member_id") == member_id:
                        own_alloc = float(alloc["quantity_kg"])
                        break
            item = {
                "availability_id": p["availability_id"],
                "farm_id": p["farm_id"],
                "crop_id": p["crop_id"],
                "period": p["period"],
                "approved_quantity_kg": float(p["approved_quantity_kg"]),
                "remaining_quantity_kg": float(rem),
                "status": p["status"],
                "version": int(p["version"]),
                "approved_at": p["approved_at"],
            }
            if own_alloc is not None:
                item["own_allocation_kg"] = own_alloc
            items.append(item)
        return items

    def list_adjustments(self, period: str) -> list[dict]:
        parse_period(period)
        return [r.payload for r in list_records(self.db, "AllocationAdjustment", period=period)]

    def adjust(self, data: dict, principal: Principal) -> dict:
        row = self.lock_availability_for_selection(data["availability_id"])
        p = dict(row.payload)
        verify_scope(principal, p["farm_id"])
        if row.version != data["expected_version"]:
            error("VERSION_CONFLICT", "Availability version is stale", 409)
        if data.get("actual_harvest_id"):
            actual = self._get_actual(data["actual_harvest_id"])
            require(actual)
            if (actual["farm_id"], actual["crop_id"], actual["period"]) != (row.farm_id, row.crop_id, row.period):
                error("ACTUAL_SCOPE_MISMATCH", "Actual harvest does not match availability", 422)
            if data["approved_quantity_kg"] > actual["actual_quantity_kg"]:
                error("ACTUAL_LIMIT", "Approved quantity cannot exceed confirmed actual harvest", 422)

        alloc = data["member_allocations"]
        ids = [a["member_id"] for a in alloc]
        if len(ids) != len(set(ids)):
            error("DUPLICATE_MEMBER_ALLOCATION", "Member allocations must be unique", 422)
        total = sum((Decimal(str(a["quantity_kg"])) for a in alloc), Decimal(0))
        quantity = Decimal(str(data["approved_quantity_kg"]))
        if total > quantity:
            error("OVER_ALLOCATION", "Member allocations exceed approved quantity", 422)
        for a in alloc:
            if not self._member_exists(a["member_id"]):
                error("MEMBER_NOT_FOUND", "Member does not exist", 404)

        # B05: Compute deltas including omitted/removed previously allocated members
        prev_map = {a["member_id"]: float(a["quantity_kg"]) for a in p.get("member_allocations", [])}
        new_map = {a["member_id"]: float(a["quantity_kg"]) for a in alloc}
        member_updates: list[dict] = []
        for mid in sorted(set(prev_map) | set(new_map)):
            old_q = prev_map.get(mid)
            new_q = new_map.get(mid, 0.0)
            removed = mid in prev_map and mid not in new_map
            if removed or old_q != new_q or mid in new_map:
                member_updates.append(
                    {
                        "member_id": mid,
                        "previous_quantity_kg": old_q,
                        "quantity_kg": new_q,
                        "removed": removed,
                    }
                )

        change = {
            "adjustment_id": new_id("ADJ"),
            "availability_id": row.id,
            "farm_id": row.farm_id,
            "crop_id": row.crop_id,
            "period": row.period,
            "expected_version": row.version,
            "version": row.version + 1,
            "approved_quantity_kg": float(quantity),
            "reason": data["reason"],
            "member_allocations": alloc,
            "member_updates": member_updates,
            "actual_harvest_id": data.get("actual_harvest_id"),
            "approved_by": principal.user_id,
            "approved_at": _now_iso(),
        }
        p["approved_quantity_kg"] = float(quantity)
        p["member_allocations"] = alloc
        p["version"] = row.version + 1
        p["allocation_changes"] = p.get("allocation_changes", []) + [change]
        update_versioned(self.db, row, data["expected_version"], p)
        save(
            self.db,
            "AllocationAdjustment",
            change,
            id=change["adjustment_id"],
            farm_id=row.farm_id,
            crop_id=row.crop_id,
            period=row.period,
            owner_id=principal.user_id,
        )
        audit(self.db, principal.user_id, "adjustAllocation", change["adjustment_id"], {"version": change["version"]})
        return change
