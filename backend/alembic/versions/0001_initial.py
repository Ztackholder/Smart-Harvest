"""Initial record and audit tables with scope constraints."""
from alembic import op
import sqlalchemy as sa
revision="0001_initial"
down_revision=None
branch_labels=None
depends_on=None
def upgrade():
 op.create_table("records",
  sa.Column("id",sa.String(80),primary_key=True),sa.Column("kind",sa.String(48),nullable=False),
  sa.Column("farm_id",sa.String(80)),sa.Column("crop_id",sa.String(48)),sa.Column("period",sa.String(8)),
  sa.Column("owner_id",sa.String(80)),sa.Column("version",sa.Integer(),nullable=False,server_default="1"),
  sa.Column("payload",sa.JSON(),nullable=False),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
  sa.CheckConstraint("version >= 1",name="ck_records_version_positive"),
  sa.ForeignKeyConstraint(["farm_id"],["records.id"],name="fk_records_farm_id"),
  sa.ForeignKeyConstraint(["crop_id"],["records.id"],name="fk_records_crop_id"),sa.CheckConstraint("kind IN ('Farm','Crop','Planting','Device','Member','Receipt','Observation','HarvestEstimate','HarvestPrediction','ApprovedAvailability','SupplyRiskAssessment','AllocationAdjustment','MemberSelection','ActualHarvest','MemberFeedback')",name="ck_records_kind"))
 for col in ("kind","farm_id","crop_id","period","owner_id"): op.create_index("ix_records_"+col,"records",[col])
 op.create_index("uq_member_period_selection","records",["owner_id","period"],unique=True,postgresql_where=sa.text("kind = 'MemberSelection'"),sqlite_where=sa.text("kind = 'MemberSelection'"))
 op.create_index("uq_active_availability_scope","records",["farm_id","crop_id","period"],unique=True,postgresql_where=sa.text("kind = 'ApprovedAvailability'"),sqlite_where=sa.text("kind = 'ApprovedAvailability'"))
 op.create_table("audit_events",sa.Column("id",sa.String(80),primary_key=True),sa.Column("actor_id",sa.String(80),nullable=False),
  sa.Column("action",sa.String(80),nullable=False),sa.Column("resource_id",sa.String(80),nullable=False),
  sa.Column("occurred_at",sa.DateTime(timezone=True),nullable=False),sa.Column("details",sa.JSON(),nullable=False))
 op.create_index("ix_audit_events_action","audit_events",["action"]);op.create_index("ix_audit_events_resource_id","audit_events",["resource_id"])
def downgrade():
 op.drop_table("audit_events");op.drop_table("records")


