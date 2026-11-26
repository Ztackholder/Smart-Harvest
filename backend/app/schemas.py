from __future__ import annotations
import math
import re
from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Measurement(StrictModel):
    type: str
    value: float
    unit: str

    @field_validator("value")
    @classmethod
    def finite(cls, v):
        if not math.isfinite(v):
            raise ValueError("value must be finite")
        return v


class ObservationIn(StrictModel):
    farm_id: str
    crop_id: str | None = None
    device_id: str | None = None
    observed_at: datetime
    source: Literal["manual", "csv", "simulated_iot", "iot", "external"]
    measurements: list[Measurement] = Field(min_length=1, max_length=12)
    provenance: str | None = None

    @field_validator("observed_at")
    @classmethod
    def aware(cls, v):
        if v.tzinfo is None or v.utcoffset() is None:
            raise ValueError("observed_at requires timezone")
        return v


class EstimateIn(StrictModel):
    farm_id: str
    crop_id: str
    harvest_period: str
    estimated_quantity_kg: float = Field(ge=0, allow_inf_nan=False)
    recorded_at: datetime

    @field_validator("recorded_at")
    @classmethod
    def aware(cls, v):
        if v.tzinfo is None or v.utcoffset() is None:
            raise ValueError("recorded_at requires timezone")
        return v


class PredictionIn(StrictModel):
    farm_id: str
    crop_id: str
    target_period: str
    data_reference_ids: list[str] = Field(default_factory=list, max_length=100)
    prediction_at: datetime | None = None
    planting_id: str | None = None

    @field_validator("prediction_at")
    @classmethod
    def aware(cls, v):
        if v is not None and (v.tzinfo is None or v.utcoffset() is None):
            raise ValueError("prediction_at requires timezone")
        return v


class ApprovalIn(StrictModel):
    farm_id: str
    crop_id: str
    period: str
    basis_type: Literal["PREDICTION", "MANUAL_ESTIMATE"]
    basis_id: str
    approved_quantity_kg: float = Field(ge=0, allow_inf_nan=False)
    approval_note: str = Field(min_length=1, max_length=1000)
    assessment_id: str | None = None
    commodity_plan_id: str | None = None


class RiskIn(StrictModel):
    prediction_id: str
    planned_demand_kg: float = Field(ge=0, allow_inf_nan=False)


class CommodityPlanBasisItem(StrictModel):
    farm_id: str
    basis_type: Literal["PREDICTION", "MANUAL_ESTIMATE"]
    basis_id: str


class CommodityPlanIn(StrictModel):
    crop_id: str
    period: str
    planned_demand_kg: float = Field(ge=0, allow_inf_nan=False)
    review_note: str = Field(default="", max_length=1000)
    verified_with_farmer: bool = False
    review_outcome: Literal["CONFIRMED", "NEEDS_ADJUSTMENT", "WAITING_FARMER"] = "CONFIRMED"
    farmer_verification_status: Literal["UNCONFIRMED", "WAITING", "CONFIRMED"] = "UNCONFIRMED"
    items: list[CommodityPlanBasisItem] | None = None


class SelectionItem(StrictModel):
    availability_id: str
    availability_version: int = Field(ge=1)
    quantity_kg: float = Field(gt=0, allow_inf_nan=False)


class SelectionIn(StrictModel):
    period: str
    items: list[SelectionItem] = Field(min_length=1, max_length=20)


class MemberAllocation(StrictModel):
    member_id: str
    quantity_kg: float = Field(ge=0, allow_inf_nan=False)


class AdjustmentIn(StrictModel):
    availability_id: str
    expected_version: int = Field(ge=1)
    approved_quantity_kg: float = Field(ge=0, allow_inf_nan=False)
    reason: str = Field(min_length=1, max_length=1000)
    member_allocations: list[MemberAllocation] = Field(max_length=200)
    actual_harvest_id: str | None = None


class ActualIn(StrictModel):
    farm_id: str
    crop_id: str
    period: str
    actual_quantity_kg: float = Field(ge=0, allow_inf_nan=False)
    harvested_at: datetime
    source: str = Field(min_length=1, max_length=64)
    confirmation_note: str = Field(min_length=1, max_length=1000)

    @field_validator("harvested_at")
    @classmethod
    def aware(cls, v):
        if v.tzinfo is None or v.utcoffset() is None:
            raise ValueError("harvested_at requires timezone")
        return v


class FeedbackIn(StrictModel):
    period: str
    comment: str = Field(min_length=1, max_length=4000)


class ReceiptIn(StrictModel):
    member_id: str
    period: str
    confirmed: bool = True


ISO_PERIOD = re.compile(r"^(19|20|21)\d{2}-W(?:0[1-9]|[1-4]\d|5[0-3])$")


def validate_period(value: str) -> str:
    if not ISO_PERIOD.fullmatch(value):
        raise ValueError("period must be ISO week YYYY-Www")
    year, week = value.split("-W")
    try:
        datetime.fromisocalendar(int(year), int(week), 1)
    except ValueError:
        raise ValueError("period is not a valid ISO week")
    return value
