from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .auth_models import AuthLoginAttempt, AuthSession, AuthUser
from .core import Principal, settings

_PASSWORDS = PasswordHasher()
_DUMMY_HASH = _PASSWORDS.hash(secrets.token_urlsafe(32))
_SESSION_LIFETIME = timedelta(hours=12)
_LOGIN_WINDOW = timedelta(minutes=15)
_LOGIN_LOCK = timedelta(minutes=15)
_MAX_LOGIN_FAILURES = 8
_PASSWORD_MIN_LENGTH = 16


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _user_profile(user: AuthUser) -> dict:
    return {
        "user_id": user.id,
        "username": user.username,
        "role": user.role,
        "name": user.display_name,
        "farm_ids": list(user.farm_ids or []),
        "member_id": user.member_id,
        "can_select": bool(user.can_select),
    }


def _principal(user: AuthUser) -> Principal:
    return Principal(
        user.id,
        user.role,
        user.display_name,
        user.farm_ids or [],
        user.member_id,
        bool(user.can_select),
    )


class AuthService:
    def __init__(self, db: Session):
        self.db = db

    def bootstrap(self) -> None:
        configured = (
            ("USR-FARMER", "auth_bootstrap_farmer_username", "auth_bootstrap_farmer_password",
             "FARMER", "Petani mitra", ["FARM-01"], None, False),
            ("USR-COORD", "auth_bootstrap_coordinator_username", "auth_bootstrap_coordinator_password",
             "COORDINATOR", "Koordinator", ["FARM-01", "FARM-02"], None, False),
            ("USR-MEMBER-01", "auth_bootstrap_member_eligible_username", "auth_bootstrap_member_eligible_password",
             "MEMBER", "Rina Kusuma", [], "MBR-001", True),
            ("USR-MEMBER-02", "auth_bootstrap_member_regular_username", "auth_bootstrap_member_regular_password",
             "MEMBER", "Budi Santoso", [], "MBR-002", False),
        )
        seen_usernames: set[str] = set()
        for user_id, username_key, password_key, role, name, farms, member_id, can_select in configured:
            existing = self.db.get(AuthUser, user_id)
            if existing:
                if role == "COORDINATOR" and set(existing.farm_ids or []) != set(farms):
                    existing.farm_ids = sorted(set(existing.farm_ids or []) | set(farms))
                continue
            username = str(getattr(settings, username_key, "") or "").strip().lower()
            password = str(getattr(settings, password_key, "") or "")
            if not username or not password:
                raise RuntimeError(f"Bootstrap username and password are required for {role}")
            if len(username) > 64 or any(ch.isspace() for ch in username):
                raise RuntimeError(f"Invalid bootstrap username for {role}")
            if len(password) < _PASSWORD_MIN_LENGTH:
                raise RuntimeError(f"Bootstrap password for {role} must contain at least 16 characters")
            if username in seen_usernames or self.db.scalar(select(AuthUser.id).where(AuthUser.username == username)):
                raise RuntimeError("Bootstrap usernames must be unique")
            seen_usernames.add(username)
            self.db.add(AuthUser(
                id=user_id,
                username=username,
                password_hash=_PASSWORDS.hash(password),
                role=role,
                display_name=name,
                farm_ids=farms,
                member_id=member_id,
                can_select=can_select,
                is_active=True,
            ))
        self.db.flush()

    def login(self, username: str, password: str, client_key: str) -> dict:
        normalized = username.strip().lower()
        attempt_hash = _digest(normalized + "\0" + client_key[:128])
        now = datetime.now(timezone.utc)
        attempt = self.db.get(AuthLoginAttempt, attempt_hash)
        if attempt and attempt.locked_until and _as_utc(attempt.locked_until) > now:
            retry = max(1, int((_as_utc(attempt.locked_until) - now).total_seconds()))
            raise HTTPException(
                status_code=429,
                detail={"code": "LOGIN_THROTTLED", "message": "Too many sign-in attempts. Try again later."},
                headers={"Retry-After": str(retry)},
            )
        if attempt and now - _as_utc(attempt.window_started_at) >= _LOGIN_WINDOW:
            attempt.failed_count = 0
            attempt.window_started_at = now
            attempt.locked_until = None

        user = self.db.scalar(select(AuthUser).where(AuthUser.username == normalized))
        stored_hash = user.password_hash if user else _DUMMY_HASH
        valid = self._verify(password, stored_hash)
        if not user or not user.is_active or not valid:
            if attempt is None:
                attempt = AuthLoginAttempt(
                    attempt_hash=attempt_hash, failed_count=0, window_started_at=now
                )
                self.db.add(attempt)
            attempt.failed_count += 1
            if attempt.failed_count >= _MAX_LOGIN_FAILURES:
                attempt.locked_until = now + _LOGIN_LOCK
            self.db.commit()
            raise HTTPException(
                status_code=401,
                detail={"code": "INVALID_CREDENTIALS", "message": "Username or password is incorrect"},
            )

        if attempt:
            self.db.delete(attempt)
        self.db.execute(delete(AuthSession).where(AuthSession.expires_at < now))
        raw_session = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(32)
        expires = now + timedelta(hours=max(1, min(settings.session_ttl_hours, 24 * 30)))
        self.db.add(AuthSession(
            token_hash=_digest(raw_session),
            user_id=user.id,
            csrf_hash=_digest(csrf_token),
            expires_at=expires,
        ))
        self.db.flush()
        return {"session_token": raw_session, "csrf_token": csrf_token, "user": _user_profile(user)}

    def authenticate(self, raw_session: str | None) -> tuple[Principal, AuthSession]:
        if not raw_session or len(raw_session) > 128:
            self._unauthenticated()
        row = self.db.get(AuthSession, _digest(raw_session))
        if not row or row.revoked_at or _as_utc(row.expires_at) <= datetime.now(timezone.utc):
            self._unauthenticated()
        user = self.db.get(AuthUser, row.user_id)
        if not user or not user.is_active:
            self._unauthenticated()
        return _principal(user), row

    def csrf_valid(self, row: AuthSession, supplied: str | None) -> bool:
        if not supplied or len(supplied) > 128:
            return False
        return hmac.compare_digest(row.csrf_hash, _digest(supplied))

    def rotate_csrf(self, row: AuthSession) -> str:
        token = secrets.token_urlsafe(32)
        row.csrf_hash = _digest(token)
        self.db.flush()
        return token

    def logout(self, row: AuthSession) -> None:
        row.revoked_at = datetime.now(timezone.utc)
        self.db.flush()

    def change_password(self, principal: Principal, current_password: str, new_password: str) -> None:
        if len(new_password) < _PASSWORD_MIN_LENGTH or len(new_password) > 256:
            raise HTTPException(
                status_code=422,
                detail={"code": "INVALID_PASSWORD", "message": "New password must be between 16 and 256 characters"},
            )
        user = self.db.get(AuthUser, principal.user_id)
        if not user or not user.is_active or not self._verify(current_password, user.password_hash):
            raise HTTPException(
                status_code=401,
                detail={"code": "INVALID_CREDENTIALS", "message": "Current password is incorrect"},
            )
        user.password_hash = _PASSWORDS.hash(new_password)
        self.db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
        self.db.flush()

    @staticmethod
    def origin_matches_host(origin: str | None, host: str | None) -> bool:
        if not origin or not host or len(origin) > 512 or len(host) > 255:
            return False
        try:
            parsed = urlsplit(origin)
            return parsed.scheme in {"http", "https"} and bool(parsed.hostname) and parsed.netloc.lower() == host.lower()
        except ValueError:
            return False

    @staticmethod
    def _verify(password: str, password_hash: str) -> bool:
        try:
            return _PASSWORDS.verify(password_hash, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    @staticmethod
    def _unauthenticated() -> None:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "A valid sign-in session is required"},
        )
