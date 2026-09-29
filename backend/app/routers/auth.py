"""
G7 -- sign-in, sign-out and session endpoints. See app/auth.py for the
design (cookie, roles, CSRF, rate limit).
"""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app import auth
from app import config
from app.schemas import AccountOut, LoginIn, SessionOut

router = APIRouter(prefix="/auth", tags=["auth"])


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    return auth.hash_password("no such account", salt="timing-equalizer")


def _session(user: auth.User, exp: int | None) -> dict:
    return {
        "auth_enabled": config.settings.auth_enabled,
        "username": user.username,
        "role": user.role,
        "expires_at": datetime.fromtimestamp(exp, tz=timezone.utc) if exp else None,
    }


@router.post("/login", response_model=SessionOut, dependencies=[Depends(auth.check_csrf)])
def login(body: LoginIn, request: Request, response: Response):
    """Checks the credentials against AUTH_USERS and sets the httpOnly
    session cookie. 401 on bad credentials (one message for unknown user
    and wrong password), 429 after repeated failures."""
    if not config.settings.auth_enabled:
        return _session(auth.ANONYMOUS_ADMIN, None)
    ip = request.client.host if request.client else "unknown"
    wait = auth.limiter.retry_after(ip, body.username)
    if wait:
        raise HTTPException(429, "Too many failed sign-ins; try again later", headers={"Retry-After": str(wait)})
    account = auth.accounts().get(body.username)
    # Verify against a dummy hash for unknown users too, so response time
    # does not reveal which usernames exist.
    stored = account[0] if account else _dummy_hash()
    if not auth.verify_password(body.password, stored) or account is None:
        auth.limiter.fail(ip, body.username)
        raise HTTPException(401, "Wrong username or password")
    auth.limiter.succeed(ip, body.username)
    token, exp = auth.issue_token(body.username)
    response.set_cookie(
        auth.COOKIE_NAME, token,
        max_age=config.settings.session_ttl_minutes * 60, httponly=True,
        samesite="strict", secure=config.settings.cookie_secure, path="/",
    )
    return _session(auth.User(body.username, account[1]), exp)


@router.post("/logout", status_code=204, dependencies=[Depends(auth.check_csrf)])
def logout(response: Response):
    """Clears the session cookie. Idempotent: signing out twice is fine."""
    response.delete_cookie(auth.COOKIE_NAME, path="/", httponly=True, samesite="strict", secure=config.settings.cookie_secure)
    response.status_code = 204
    return response


@router.get("/me", response_model=SessionOut)
def me(request: Request):
    """The signed-in account and role; 401 when there is no valid session.
    With AUTH_ENABLED=false, reports auth_enabled: false and an anonymous
    admin, so the frontend can skip the sign-in screen."""
    user = auth.session_user(request)
    if user is None:
        raise HTTPException(401, "Not signed in")
    exp = None
    token = request.cookies.get(auth.COOKIE_NAME)
    if config.settings.auth_enabled and token:
        parsed = auth.read_token(token)
        exp = parsed[1] if parsed else None
    return _session(user, exp)


@router.get("/users", response_model=list[AccountOut])
def users(_: Annotated[auth.User, Depends(auth.require_role("admin"))]):
    """Configured accounts and their roles (never passwords). Admin only."""
    return [{"username": name, "role": role} for name, (_, role) in sorted(auth.accounts().items())]
