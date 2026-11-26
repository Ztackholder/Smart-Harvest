"""Add username/password users and opaque browser sessions."""
from alembic import op
import sqlalchemy as sa

revision = "0002_password_sessions"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("auth_users"):
        op.create_table(
        "auth_users",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("password_hash", sa.String(512), nullable=False),
        sa.Column("role", sa.String(24), nullable=False),
        sa.Column("display_name", sa.String(120), nullable=False),
        sa.Column("farm_ids", sa.JSON(), nullable=False),
        sa.Column("member_id", sa.String(80)),
        sa.Column("can_select", sa.Boolean(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("role IN ('FARMER','COORDINATOR','MEMBER')", name="ck_auth_users_role"),
        )
    if not any(index["name"] == "uq_auth_users_username" for index in sa.inspect(bind).get_indexes("auth_users")):
        op.create_index("uq_auth_users_username", "auth_users", ["username"], unique=True)
    if not sa.inspect(bind).has_table("auth_sessions"):
        op.create_table(
        "auth_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(80), sa.ForeignKey("auth_users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("csrf_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        )
    if not any(index["name"] == "ix_auth_sessions_user_expires" for index in sa.inspect(bind).get_indexes("auth_sessions")):
        op.create_index("ix_auth_sessions_user_expires", "auth_sessions", ["user_id", "expires_at"])
    if not sa.inspect(bind).has_table("auth_login_attempts"):
        op.create_table(
        "auth_login_attempts",
        sa.Column("attempt_hash", sa.String(64), primary_key=True),
        sa.Column("failed_count", sa.Integer(), nullable=False),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True)),
        )


def downgrade():
    op.drop_table("auth_login_attempts")
    op.drop_index("ix_auth_sessions_user_expires", table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_index("uq_auth_users_username", table_name="auth_users")
    op.drop_table("auth_users")
