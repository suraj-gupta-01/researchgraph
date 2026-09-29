"""
G7 -- authentication and role-based access (PRD Section 8: "authentication,
role-based access", credentials via environment variables).

Deliberately small and stdlib-only:

  Accounts   AUTH_USERS="alice:secret:analyst,bob:pbkdf2_sha256$...:viewer".
             Passwords may be plain (demo) or pbkdf2_sha256 hashes
             (`python -m app.auth hash <password>`); both compare in constant
             time.
  Roles      viewer < analyst < admin. viewer reads every dashboard;
             analyst also runs the Section 9 query lab (it exposes raw SQL
             and the schema); admin also lists accounts.
  Sessions   A signed, expiring token (HMAC-SHA256 over {user, exp}) in an
             httpOnly, SameSite=Strict cookie -- never readable by page
             script, so never in localStorage. The role is NOT trusted from
             the token: every request re-reads it from AUTH_USERS, so a
             demoted or removed account loses access at once.
  CSRF       Every state-changing request (the two POSTs) must carry
             X-Requested-With: ResearchGraph, a header a cross-site form or
             image cannot send and a cross-origin script cannot send without
             a CORS preflight the API refuses; an Origin header, when
             present, must also be an allowed origin.
  Rate limit Failed logins are counted per client IP and per IP+username in
             a sliding window; over the limit, 429 with Retry-After.

AUTH_ENABLED=false turns all of this off (every request acts as an admin);
the test suite and an open demo use that.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from functools import lru_cache

from fastapi import HTTPException, Request

from app import config

log = logging.getLogger("researchgraph.auth")

ROLES = ("viewer", "analyst", "admin")
COOKIE_NAME = "rg_session"
CSRF_HEADER = "X-Requested-With"
CSRF_VALUE = "ResearchGraph"
_PBKDF2_PREFIX = "pbkdf2_sha256$"
_PBKDF2_ITERATIONS = 240_000


@dataclass(frozen=True)
class User:
    username: str
    role: str

    def has(self, role: str) -> bool:
        return ROLES.index(self.role) >= ROLES.index(role)


ANONYMOUS_ADMIN = User(username="anonymous", role="admin")


# ---- passwords --------------------------------------------------------------

def hash_password(password: str, *, salt: str | None = None, iterations: int = _PBKDF2_ITERATIONS) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations).hex()
    return f"{_PBKDF2_PREFIX}{iterations}${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    if stored.startswith(_PBKDF2_PREFIX):
        try:
            iterations, salt, digest = stored[len(_PBKDF2_PREFIX):].split("$")
            candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
        except ValueError:
            return False
        return hmac.compare_digest(candidate, digest)
    return hmac.compare_digest(password.encode(), stored.encode())


# ---- accounts ---------------------------------------------------------------

def parse_users(spec: str) -> dict[str, tuple[str, str]]:
    """'name:password:role,...' -> {name: (password, role)}. Malformed
    entries and unknown roles are skipped with a warning, never guessed."""
    users: dict[str, tuple[str, str]] = {}
    for raw in spec.split(","):
        entry = raw.strip()
        if not entry:
            continue
        name, sep1, rest = entry.partition(":")
        password, sep2, role = rest.rpartition(":")
        role = role.strip().lower()
        if not (sep1 and sep2 and name.strip() and password and role in ROLES):
            log.warning("AUTH_USERS: skipping malformed entry for %r", name.strip() or "?")
            continue
        users[name.strip()] = (password, role)
    return users


def accounts() -> dict[str, tuple[str, str]]:
    return parse_users(config.settings.auth_users)


# ---- session tokens ---------------------------------------------------------

@lru_cache(maxsize=1)
def _random_secret() -> bytes:
    log.warning("SESSION_SECRET is not set; using a random per-process key (sessions end on restart)")
    return secrets.token_bytes(32)


def _secret() -> bytes:
    return config.settings.session_secret.encode() if config.settings.session_secret else _random_secret()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def issue_token(username: str, *, now: float | None = None) -> tuple[str, int]:
    """Returns (token, expires_at_epoch_seconds)."""
    exp = int((now if now is not None else time.time()) + config.settings.session_ttl_minutes * 60)
    payload = _b64(json.dumps({"u": username, "exp": exp}, separators=(",", ":")).encode())
    sig = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}", exp


def read_token(token: str, *, now: float | None = None) -> tuple[str, int] | None:
    """(username, exp) for a valid, unexpired token; None otherwise."""
    payload, _, sig = token.partition(".")
    if not payload or not sig:
        return None
    expected = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        data = json.loads(_unb64(payload))
        username, exp = str(data["u"]), int(data["exp"])
    except (ValueError, KeyError, TypeError):
        return None
    if exp <= (now if now is not None else time.time()):
        return None
    return username, exp


# ---- login rate limiting ----------------------------------------------------

class LoginLimiter:
    """Sliding-window failure counter. In-process, which matches the single
    uvicorn worker this project runs; a multi-worker deployment would move
    this to a shared store."""

    def __init__(self, per_user: int = 5, per_ip: int = 20, window_s: int = 300):
        self.per_user, self.per_ip, self.window_s = per_user, per_ip, window_s
        self._fails: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str, now: float) -> deque[float]:
        q = self._fails.setdefault(key, deque())
        while q and q[0] <= now - self.window_s:
            q.popleft()
        return q

    def retry_after(self, ip: str, username: str, now: float | None = None) -> int:
        """Seconds until another attempt is allowed; 0 if allowed now."""
        now = time.time() if now is None else now
        with self._lock:
            waits = []
            for key, limit in ((f"ip:{ip}", self.per_ip), (f"u:{ip}:{username.lower()}", self.per_user)):
                q = self._recent(key, now)
                if len(q) >= limit:
                    waits.append(int(q[0] + self.window_s - now) + 1)
            return max(waits, default=0)

    def fail(self, ip: str, username: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            self._recent(f"ip:{ip}", now).append(now)
            self._recent(f"u:{ip}:{username.lower()}", now).append(now)

    def succeed(self, ip: str, username: str) -> None:
        with self._lock:
            self._fails.pop(f"u:{ip}:{username.lower()}", None)

    def reset(self) -> None:
        with self._lock:
            self._fails.clear()


limiter = LoginLimiter()


# ---- request dependencies ---------------------------------------------------

def session_user(request: Request) -> User | None:
    if not config.settings.auth_enabled:
        return ANONYMOUS_ADMIN
    token = request.cookies.get(COOKIE_NAME)
    parsed = read_token(token) if token else None
    if parsed is None:
        return None
    account = accounts().get(parsed[0])
    if account is None:          # removed from AUTH_USERS since sign-in
        return None
    return User(username=parsed[0], role=account[1])


def require_role(role: str):
    def dependency(request: Request) -> User:
        user = session_user(request)
        if user is None:
            raise HTTPException(401, "Sign in required", headers={"WWW-Authenticate": "Cookie"})
        if not user.has(role):
            raise HTTPException(403, f"Requires the {role} role")
        return user

    dependency.__name__ = f"require_{role}"
    return dependency


def check_csrf(request: Request) -> None:
    if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        raise HTTPException(403, f"Missing {CSRF_HEADER} header")
    origin = request.headers.get("origin")
    if origin and origin not in config.settings.cors_origins:
        raise HTTPException(403, "Origin not allowed")


def main(argv: list[str]) -> None:
    if len(argv) == 2 and argv[0] == "hash":
        print(hash_password(argv[1]))
    else:
        print("usage: python -m app.auth hash <password>")


if __name__ == "__main__":
    main(sys.argv[1:])
