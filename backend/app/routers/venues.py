from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.db import get_conn
from app.schemas import Page, VenueDetail, VenueSummary
from app.sqlutil import PageParams, fetch_all, fetch_one, like_pattern, page, page_params

router = APIRouter(prefix="/venues", tags=["venues"])

_SORTS = {
    "papers": "paper_count DESC, v.Venue_Name, v.Venue_ID",
    "name": "v.Venue_Name ASC, v.Venue_ID",
}
_STATS = "LEFT JOIN (SELECT Venue_ID, COUNT(*) AS paper_count FROM PAPER GROUP BY Venue_ID) ps ON ps.Venue_ID = v.Venue_ID"
_COLS = (
    "v.Venue_ID AS venue_id, v.Venue_Name AS venue_name, v.Venue_Type AS venue_type, "
    "v.Publisher AS publisher, COALESCE(ps.paper_count, 0) AS paper_count"
)


@router.get("", response_model=Page[VenueSummary])
def list_venues(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    venue_type: Annotated[str | None, Query(max_length=30)] = None,
    sort: Literal["papers", "name"] = "papers",
):
    where, params = [], {}
    if q:
        where.append("v.Venue_Name ILIKE :pat ESCAPE '\\'")
        params["pat"] = like_pattern(q.strip())
    if venue_type:
        where.append("v.Venue_Type = :vtype")
        params["vtype"] = venue_type
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute(text(f"SELECT COUNT(*) FROM VENUE v {where_sql}"), params).scalar_one()
    items = fetch_all(
        conn,
        f"SELECT {_COLS} FROM VENUE v {_STATS} {where_sql} ORDER BY {_SORTS[sort]} LIMIT :limit OFFSET :offset",
        {**params, "limit": p.limit, "offset": p.offset},
    )
    return page(items, total, p)


@router.get("/{venue_id}", response_model=VenueDetail)
def venue_detail(venue_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    base = fetch_one(
        conn,
        f"SELECT {_COLS}, v.ISSN AS issn FROM VENUE v {_STATS} WHERE v.Venue_ID = :id",
        {"id": venue_id},
    )
    if base is None:
        raise HTTPException(404, "Venue not found")
    by_year = fetch_all(
        conn,
        "SELECT Publication_Year AS year, COUNT(*) AS paper_count FROM PAPER WHERE Venue_ID = :id "
        "GROUP BY Publication_Year ORDER BY Publication_Year",
        {"id": venue_id},
    )
    return {**base, "papers_by_year": by_year}
