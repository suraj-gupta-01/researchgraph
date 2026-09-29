"""
G7 -- authentication and roles. The rest of the suite runs with
AUTH_ENABLED=false (conftest); every test here switches it on with three
known accounts, then drives the real app over TestClient's cookie jar.
"""
from __future__ import annotations

import dataclasses

import pytest
from fastapi.testclient import TestClient

from app import auth, config

CSRF = {auth.CSRF_HEADER: auth.CSRF_VALUE}
USERS = "vera:viewer-pw:viewer,ana:analyst-pw:analyst,adam:" + auth.hash_password("admin-pw", iterations=1000) + ":admin"


@pytest.fixture
def secured(monkeypatch, seeded):
    monkeypatch.setattr(
        config, "settings",
        dataclasses.replace(config.settings, auth_enabled=True, auth_users=USERS, session_secret="test-secret", session_ttl_minutes=60),
    )
    auth.limiter.reset()
    yield
    auth.limiter.reset()


@pytest.fixture
def web(secured):
    """A fresh client (own cookie jar) per test."""
    from app.main import app

    return TestClient(app)


def _login(web, username, password, headers=CSRF):
    return web.post("/auth/login", json={"username": username, "password": password}, headers=headers)


# ============================================================
# Pure helpers
# ============================================================

def test_password_hash_round_trip():
    h = auth.hash_password("s3cret", iterations=1000)
    assert h.startswith("pbkdf2_sha256$1000$")
    assert auth.verify_password("s3cret", h)
    assert not auth.verify_password("S3cret", h)
    assert auth.verify_password("plain", "plain") and not auth.verify_password("plain", "other")


def test_parse_users_skips_malformed_and_unknown_roles():
    users = auth.parse_users("a:pw:viewer, b:pw:superuser, :pw:admin, c-no-role, d:pw:with:colons:analyst")
    assert users == {"a": ("pw", "viewer"), "d": ("pw:with:colons", "analyst")}


def test_tokens_expire_and_reject_tampering(secured):
    token, exp = auth.issue_token("vera", now=1000.0)
    assert auth.read_token(token, now=1001.0) == ("vera", exp)
    assert auth.read_token(token, now=exp) is None
    payload, sig = token.split(".")
    forged = auth._b64(b'{"u":"adam","exp":99999999999}')
    assert auth.read_token(f"{forged}.{sig}", now=1001.0) is None
    assert auth.read_token("garbage", now=1001.0) is None


def test_limiter_blocks_after_repeated_failures():
    lim = auth.LoginLimiter(per_user=3, per_ip=10, window_s=60)
    for _ in range(3):
        assert lim.retry_after("1.1.1.1", "x", now=0) == 0
        lim.fail("1.1.1.1", "x", now=0)
    assert lim.retry_after("1.1.1.1", "x", now=1) > 0
    assert lim.retry_after("1.1.1.1", "other", now=1) == 0     # per-user bucket
    assert lim.retry_after("1.1.1.1", "x", now=61) == 0        # window slid


# ============================================================
# Endpoints
# ============================================================

def test_data_endpoints_require_a_session(web):
    assert web.get("/papers").status_code == 401
    assert web.get("/auth/me").status_code == 401
    assert web.get("/health").status_code in (200, 503)       # stays public


def test_login_sets_an_httponly_strict_cookie_and_me_reports_the_role(web):
    r = _login(web, "vera", "viewer-pw")
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "viewer" and r.json()["auth_enabled"] is True
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and auth.COOKIE_NAME in cookie
    me = web.get("/auth/me").json()
    assert me["username"] == "vera" and me["expires_at"]
    assert web.get("/papers").status_code == 200


def test_bad_credentials_get_one_message(web):
    a = _login(web, "vera", "wrong")
    b = _login(web, "nobody", "wrong")
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json()


def test_hashed_passwords_work(web):
    assert _login(web, "adam", "admin-pw").json()["role"] == "admin"


def test_login_requires_the_csrf_header(web):
    assert _login(web, "vera", "viewer-pw", headers={}).status_code == 403


def test_login_rejects_a_foreign_origin(web):
    r = _login(web, "vera", "viewer-pw", headers={**CSRF, "Origin": "https://evil.example"})
    assert r.status_code == 403


def test_repeated_failures_are_rate_limited(web):
    for _ in range(auth.limiter.per_user):
        assert _login(web, "vera", "wrong").status_code == 401
    r = _login(web, "vera", "viewer-pw")      # even the right password, while locked
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0


def test_viewer_cannot_run_the_query_lab_but_analyst_can(web):
    _login(web, "vera", "viewer-pw")
    assert web.get("/queries/catalog").status_code == 403
    web.cookies.clear()
    _login(web, "ana", "analyst-pw")
    assert web.get("/queries/catalog").status_code == 200
    assert web.get("/auth/users").status_code == 403


def test_admin_lists_accounts_without_passwords(web):
    _login(web, "adam", "admin-pw")
    body = web.get("/auth/users").json()
    assert body == [{"username": "adam", "role": "admin"}, {"username": "ana", "role": "analyst"}, {"username": "vera", "role": "viewer"}]


def test_logout_clears_the_session(web):
    _login(web, "vera", "viewer-pw")
    assert web.post("/auth/logout", headers=CSRF).status_code == 204
    assert web.get("/auth/me").status_code == 401
    assert web.post("/auth/logout").status_code == 403       # CSRF guard applies here too


def test_role_is_reread_from_config_on_every_request(web, monkeypatch):
    _login(web, "ana", "analyst-pw")
    assert web.get("/queries/catalog").status_code == 200
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, auth_users="ana:analyst-pw:viewer"))
    assert web.get("/queries/catalog").status_code == 403
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, auth_users="vera:viewer-pw:viewer"))
    assert web.get("/auth/me").status_code == 401             # account removed


def test_auth_disabled_reports_an_anonymous_admin(seeded):
    from app.main import app

    web = TestClient(app)
    me = web.get("/auth/me").json()
    assert me == {"auth_enabled": False, "username": "anonymous", "role": "admin", "expires_at": None}
    assert web.get("/queries/catalog").status_code == 200
