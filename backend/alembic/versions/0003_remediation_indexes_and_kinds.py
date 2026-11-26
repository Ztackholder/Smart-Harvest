"""remediation record kinds and observation window index

Revision ID: 0003_remediation_indexes_and_kinds
Revises: 0002_password_sessions
Create Date: 2026-11-26
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0003_remediation_kinds"
down_revision = "0002_password_sessions"
branch_labels = None
depends_on = None

NEW_KINDS = (
    "'Farm','Crop','Planting','Device','Member','Receipt','Observation',"
    "'HarvestEstimate','HarvestPrediction','PredictionState','ApprovedAvailability',"
    "'SupplyRiskAssessment','CommodityPlan','AllocationAdjustment','MemberSelection',"
    "'ActualHarvest','MemberFeedback'"
)
OLD_KINDS = (
    "'Farm','Crop','Planting','Device','Member','Receipt','Observation',"
    "'HarvestEstimate','HarvestPrediction','ApprovedAvailability',"
    "'SupplyRiskAssessment','AllocationAdjustment','MemberSelection',"
    "'ActualHarvest','MemberFeedback'"
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_indexes = {idx["name"] for idx in inspector.get_indexes("records")}
    if "ix_records_kind_farm_created" not in existing_indexes:
        op.create_index("ix_records_kind_farm_created", "records", ["kind", "farm_id", "created_at"])
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TABLE records DROP CONSTRAINT IF EXISTS ck_records_kind")
        op.create_check_constraint("ck_records_kind", "records", f"kind IN ({NEW_KINDS})")


def downgrade() -> None:
    bind = op.get_bind()
    op.drop_index("ix_records_kind_farm_created", table_name="records")
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TABLE records DROP CONSTRAINT IF EXISTS ck_records_kind")
        op.create_check_constraint("ck_records_kind", "records", f"kind IN ({OLD_KINDS})")
