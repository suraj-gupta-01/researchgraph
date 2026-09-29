"""
Small SQL helpers shared by the routers.

Security note (PRD Section 8): every user-supplied value reaches Postgres as a
bound parameter. The only strings interpolated into SQL text are fixed
constants chosen from the whitelists below (sort orders) or built from
hard-coded fragments in this codebase - never from request data.
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Query
from sqlalchemy import text
from sqlalchemy.engine import Connection


@dataclass
class PageParams:
    limit: int
    offset: int


def page_params(
    limit: int = Query(20, ge=1, le=100, description="Page size"),
    offset: int = Query(0, ge=0, le=100_000, description="Rows to skip"),
) -> PageParams:
    return PageParams(limit=limit, offset=offset)


def like_pattern(term: str) -> str:
    """Build a contains-pattern for ILIKE ... ESCAPE '\\', escaping the LIKE
    wildcards so user input is matched literally."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def fetch_all(conn: Connection, sql: str, params: dict | None = None) -> list[dict]:
    return [dict(r) for r in conn.execute(text(sql), params or {}).mappings().all()]


def fetch_one(conn: Connection, sql: str, params: dict | None = None) -> dict | None:
    row = conn.execute(text(sql), params or {}).mappings().first()
    return dict(row) if row else None


def page(items: list, total: int, p: PageParams) -> dict:
    return {"items": items, "total": total, "limit": p.limit, "offset": p.offset}
