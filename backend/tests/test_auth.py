from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.app.core import settings
from backend.app.main import app


def configure_test_auth(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{tmp_path.as_posix()}/auth.sqlite")
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "session_cookie_secure", False)
    monkeypatch.setattr(settings, "public_profile", False)
    monkeypatch.setattr(settings, "trusted_hosts", "localhost,testserver")
    monkeypatch.setattr(settings, "model_enabled", False)
    monkeypatch.setitem(settings.__dict__, "auth_bootstrap_farmer_username", "farmer")
    monkeypatch.setitem(settings.__dict__, "auth_bootstrap_farmer_password", "farmer-test-password-123")
    monkeypatch.setitem(settings.__dict__, "auth_bootstrap_coordinator_username", "coordinator")
    monkeypatch.setitem(settings.__dict__, "auth_bootstrap_coordinator_password", "coordinator-test-password-123")
    monkeypatch.setitem(settings.__dict__, "auth_bootstrap_member_eligible_username", "member-eligible")
    monkeypatch.setitem(settings.__dict__, "auth_bootstrap_member_eligible_password", "eligible-test-password-123")
    monkeypatch.setitem(settings.__dict__, "auth_bootstrap_member_regular_username", "member-regular")
    monkeypatch.setitem(settings.__dict__, "auth_bootstrap_member_regular_password", "regular-test-password-123")
    monkeypatch.setitem(settings.__dict__, "session_ttl_hours", 12)


def login(client: TestClient, username: str, password: str):
    return client.post(
        "/api/v1/auth/login",
        headers={"Origin": "http://localhost"},
        json={"username": username, "password": password},
    )


def test_username_password_login_issues_opaque_cookie_and_profile(monkeypatch, tmp_path):
    configure_test_auth(monkeypatch, tmp_path)
    with TestClient(app, headers={"host": "localhost"}) as client:
        response = login(client, "farmer", "farmer-test-password-123")

        assert response.status_code == 200, response.text
        assert "access_token" not in response.json()
        assert "session_id" not in response.json()
        assert response.json()["user"] == {
            "user_id": "USR-FARMER",
            "username": "farmer",
            "role": "FARMER",
            "name": "Petani mitra",
            "farm_ids": ["FARM-01"],
            "member_id": None,
            "can_select": False,
        }
        cookie = response.cookies.get("smartharvest_session")
        assert cookie
        set_cookie = response.headers["set-cookie"].lower()
        assert "httponly" in set_cookie and "samesite=lax" in set_cookie
        profile = client.get("/api/v1/auth/me")
        assert profile.status_code == 200
        assert profile.json()["user"]["username"] == "farmer"
        assert profile.json()["csrf_token"]


def test_wrong_password_and_unknown_user_have_same_generic_error(monkeypatch, tmp_path):
    configure_test_auth(monkeypatch, tmp_path)
    with TestClient(app, headers={"host": "localhost"}) as client:
        wrong_password = login(client, "farmer", "not-the-password")
        unknown_user = login(client, "not-a-user", "not-the-password")

        assert wrong_password.status_code == unknown_user.status_code == 401
        assert wrong_password.json() == unknown_user.json()
        assert wrong_password.json()["error"]["code"] == "INVALID_CREDENTIALS"
        assert not client.cookies.get("smartharvest_session")


def test_login_checks_origin_and_throttles_failed_attempts(monkeypatch, tmp_path):
    configure_test_auth(monkeypatch, tmp_path)
    with TestClient(app, headers={"host": "localhost"}) as client:
        cross_site = client.post(
            "/api/v1/auth/login",
            headers={"Origin": "https://attacker.example"},
            json={"username": "farmer", "password": "farmer-test-password-123"},
        )
        assert cross_site.status_code == 403

        for _ in range(8):
            response = login(client, "farmer", "wrong-password")
            assert response.status_code == 401
        limited = login(client, "farmer", "wrong-password")
        assert limited.status_code == 429


def test_csrf_logout_and_password_change_revoke_sessions(monkeypatch, tmp_path):
    configure_test_auth(monkeypatch, tmp_path)
    with TestClient(app, headers={"host": "localhost"}) as client:
        signed_in = login(client, "farmer", "farmer-test-password-123")
        csrf = signed_in.json()["csrf_token"]
        estimate = {
            "farm_id": "FARM-01",
            "crop_id": "SPINACH",
            "harvest_period": "2026-W48",
            "estimated_quantity_kg": 5,
            "recorded_at": "2026-11-26T00:00:00Z",
        }
        missing_csrf = client.post("/api/v1/harvest-estimates", json=estimate)
        assert missing_csrf.status_code == 403
        saved = client.post(
            "/api/v1/harvest-estimates",
            headers={"X-CSRF-Token": csrf},
            json=estimate,
        )
        assert saved.status_code == 201, saved.text

        password_change = client.post(
            "/api/v1/auth/password",
            headers={"X-CSRF-Token": csrf},
            json={"current_password": "farmer-test-password-123", "new_password": "farmer-new-password-123"},
        )
        assert password_change.status_code == 200
        assert client.get("/api/v1/auth/me").status_code == 401
        assert login(client, "farmer", "farmer-test-password-123").status_code == 401
        assert login(client, "farmer", "farmer-new-password-123").status_code == 200

        csrf = client.get("/api/v1/auth/me").json()["csrf_token"]
        logout = client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
        assert logout.status_code == 200
        assert client.get("/api/v1/auth/me").status_code == 401


def test_old_bearer_token_does_not_authorize(monkeypatch, tmp_path):
    configure_test_auth(monkeypatch, tmp_path)
    with TestClient(app, headers={"host": "localhost"}) as client:
        response = client.get(
            "/api/v1/catalog",
            headers={"Authorization": "Bearer legacy-token"},
        )
        assert response.status_code == 401
