from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.db import get_conn
from app.schemas import ConvergingTopicPair, Page, TopicDetail, TopicPairTrend, TopicSummary, TopicTrend, TrendingTopic
from app.sqlutil import PageParams, fetch_all, fetch_one, like_pattern, page, page_params
from graph.convergence_core import canonical_pair

router = APIRouter(prefix="/topics", tags=["topics"])

_STATS = "LEFT JOIN (SELECT Topic_ID, COUNT(*) AS paper_count FROM PAPER_TOPIC GROUP BY Topic_ID) ps ON ps.Topic_ID = t.Topic_ID"
_COLS = (
    "t.Topic_ID AS topic_id, t.Topic_Name AS topic_name, t.Parent_Topic_ID AS parent_topic_id, "
    "COALESCE(ps.paper_count, 0) AS paper_count"
)


@router.get("", response_model=Page[TopicSummary])
def list_topics(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    parent_id: Annotated[int | None, Query(ge=1, description="Only direct children of this topic")] = None,
):
    """Topics are populated by ingestion.extract_topics (M3)."""
    where, params = [], {}
    if q:
        where.append("t.Topic_Name ILIKE :pat ESCAPE '\\'")
        params["pat"] = like_pattern(q.strip())
    if parent_id is not None:
        where.append("t.Parent_Topic_ID = :parent")
        params["parent"] = parent_id
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute(text(f"SELECT COUNT(*) FROM TOPIC t {where_sql}"), params).scalar_one()
    items = fetch_all(
        conn,
        f"SELECT {_COLS} FROM TOPIC t {_STATS} {where_sql} ORDER BY paper_count DESC, t.Topic_Name LIMIT :limit OFFSET :offset",
        {**params, "limit": p.limit, "offset": p.offset},
    )
    return page(items, total, p)


_TREND_ORDER = {"Emerging": "rt.Score DESC", "Declining": "rt.Score ASC"}

_TRENDING_SQL = """
SELECT rt.Topic_ID AS topic_id, t.Topic_Name AS topic_name, rt.Period_Year AS year,
       ts.Paper_Count AS paper_count, COALESCE(prior.Paper_Count, 0) AS prior_year_paper_count,
       ts.Growth_Rate::float8 AS growth_rate, rt.Score::float8 AS score, rt.Trend_Label AS trend_label
FROM RESEARCH_TREND rt
JOIN TOPIC t ON t.Topic_ID = rt.Topic_ID
JOIN TOPIC_SNAPSHOT ts ON ts.Topic_ID = rt.Topic_ID AND ts.Snapshot_Year = rt.Period_Year
LEFT JOIN TOPIC_SNAPSHOT prior ON prior.Topic_ID = rt.Topic_ID AND prior.Snapshot_Year = rt.Period_Year - 1
WHERE rt.Trend_Label = :label AND rt.Period_Year = :year
"""


@router.get("/trending", response_model=Page[TrendingTopic])
def list_trending_topics(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    direction: Annotated[Literal["emerging", "declining"], Query(description="Which trend label to rank")] = "emerging",
    year: Annotated[int | None, Query(ge=1, le=2100, description="Defaults to the most recent period graph.trends has classified")] = None,
):
    """Topics currently classified Emerging or Declining (F3), most extreme
    first. Populated by `python -m graph.trends`; empty until it has run.
    """
    label = "Emerging" if direction == "emerging" else "Declining"
    if year is None:
        year = conn.execute(text("SELECT MAX(Period_Year) FROM RESEARCH_TREND WHERE Trend_Label = :label"), {"label": label}).scalar_one_or_none()
    if year is None:
        return page([], 0, p)

    params = {"label": label, "year": year}
    total = conn.execute(text(f"SELECT COUNT(*) FROM ({_TRENDING_SQL}) c"), params).scalar_one()
    items = fetch_all(
        conn,
        f"{_TRENDING_SQL} ORDER BY {_TREND_ORDER[label]}, rt.Topic_ID LIMIT :limit OFFSET :offset",
        {**params, "limit": p.limit, "offset": p.offset},
    )
    return page(items, total, p)


_CONVERGING_SQL = """
SELECT tpt.Topic_A_ID AS topic_a_id, ta.Topic_Name AS topic_a_name,
       tpt.Topic_B_ID AS topic_b_id, tb.Topic_Name AS topic_b_name,
       tpt.Period_Year AS year, tpt.Cooccurrence_Count AS cooccurrence_count,
       tpt.Prior_Cooccurrence_Count AS prior_cooccurrence_count,
       tpt.Growth_Rate::float8 AS growth_rate, tpt.Convergence_Score::float8 AS convergence_score
FROM TOPIC_PAIR_TREND tpt
JOIN TOPIC ta ON ta.Topic_ID = tpt.Topic_A_ID
JOIN TOPIC tb ON tb.Topic_ID = tpt.Topic_B_ID
WHERE tpt.Is_Converging AND tpt.Period_Year = :year
"""


@router.get("/converging", response_model=Page[ConvergingTopicPair])
def list_converging_topics(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    year: Annotated[int | None, Query(ge=1, le=2100, description="Defaults to the most recent period graph.convergence has classified")] = None,
):
    """F5's acceptance criterion — "a ranked list of converging topic pairs
    ... with a trend indicator" — highest Convergence_Score first. Populated
    by `python -m graph.convergence`; empty (not an error) until it has run,
    same convention as /topics/trending.
    """
    if year is None:
        year = conn.execute(text("SELECT MAX(Period_Year) FROM TOPIC_PAIR_TREND WHERE Is_Converging")).scalar_one_or_none()
    if year is None:
        return page([], 0, p)

    params = {"year": year}
    total = conn.execute(text(f"SELECT COUNT(*) FROM ({_CONVERGING_SQL}) c"), params).scalar_one()
    items = fetch_all(
        conn,
        f"{_CONVERGING_SQL} ORDER BY tpt.Convergence_Score DESC, tpt.Topic_A_ID, tpt.Topic_B_ID LIMIT :limit OFFSET :offset",
        {**params, "limit": p.limit, "offset": p.offset},
    )
    return page(items, total, p)


@router.get("/pairs/{topic_a_id}/{topic_b_id}/trend", response_model=TopicPairTrend)
def topic_pair_trend(topic_a_id: int, topic_b_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    """Gap G3 (api-coverage.md §4) -- the pair's full TOPIC_PAIR_TREND
    history, oldest year first, for the Phase 6b pair drawer's co-occurrence
    trajectory. Canonicalizes the id order (low id first, the same device
    as graph.convergence_core.canonical_pair and the table's own CHECK
    (Topic_A_ID < Topic_B_ID)) so either order in the URL resolves to the
    same pair. 404s if either topic does not exist; an existing pair with
    no TOPIC_PAIR_TREND rows (never co-occurred, co-occurred too rarely to
    be classified, or `python -m graph.convergence` hasn't run) returns an
    empty points list and a null algorithm -- same "not computed yet"
    convention as /topics/{id}/trend, not an error."""
    try:
        lo, hi = canonical_pair(topic_a_id, topic_b_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    names = fetch_all(
        conn,
        "SELECT Topic_ID AS topic_id, Topic_Name AS topic_name FROM TOPIC WHERE Topic_ID IN (:a, :b)",
        {"a": lo, "b": hi},
    )
    by_id = {n["topic_id"]: n["topic_name"] for n in names}
    if lo not in by_id or hi not in by_id:
        raise HTTPException(404, "Topic not found")

    points = fetch_all(
        conn,
        """
        SELECT tpt.Period_Year AS year, tpt.Cooccurrence_Count AS cooccurrence_count,
               tpt.Prior_Cooccurrence_Count AS prior_cooccurrence_count,
               tpt.Growth_Rate::float8 AS growth_rate, tpt.Is_Converging AS is_converging,
               tpt.Algorithm AS algorithm
        FROM TOPIC_PAIR_TREND tpt
        WHERE tpt.Topic_A_ID = :a AND tpt.Topic_B_ID = :b
        ORDER BY tpt.Period_Year
        """,
        {"a": lo, "b": hi},
    )
    algorithm = next((pt["algorithm"] for pt in points if pt["algorithm"]), None)
    for pt in points:
        del pt["algorithm"]
    return {
        "topic_a_id": lo, "topic_a_name": by_id[lo],
        "topic_b_id": hi, "topic_b_name": by_id[hi],
        "algorithm": algorithm, "points": points,
    }


@router.get("/{topic_id}/trend", response_model=TopicTrend)
def topic_trend(topic_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    """A topic's full TOPIC_SNAPSHOT/RESEARCH_TREND history, oldest year
    first — the F3 acceptance criterion's "topic-over-time chart and a
    trend label". Points list is empty until `python -m graph.trends` runs;
    the topic itself still 404s if it doesn't exist."""
    name = conn.execute(text("SELECT Topic_Name FROM TOPIC WHERE Topic_ID = :id"), {"id": topic_id}).scalar_one_or_none()
    if name is None:
        raise HTTPException(404, "Topic not found")
    points = fetch_all(
        conn,
        """
        SELECT ts.Snapshot_Year AS year, ts.Paper_Count AS paper_count, ts.Author_Count AS author_count,
               ts.Institution_Count AS institution_count, ts.Citation_Count AS citation_count,
               ts.Growth_Rate::float8 AS growth_rate, rt.Trend_Label AS trend_label,
               rt.Score::float8 AS score, rt.Algorithm AS algorithm
        FROM TOPIC_SNAPSHOT ts
        LEFT JOIN RESEARCH_TREND rt ON rt.Topic_ID = ts.Topic_ID AND rt.Period_Year = ts.Snapshot_Year
        WHERE ts.Topic_ID = :id
        ORDER BY ts.Snapshot_Year
        """,
        {"id": topic_id},
    )
    algorithm = next((pt["algorithm"] for pt in points if pt["algorithm"]), None)
    for pt in points:
        del pt["algorithm"]
    return {"topic_id": topic_id, "topic_name": name, "algorithm": algorithm, "points": points}


@router.get("/{topic_id}", response_model=TopicDetail)
def topic_detail(topic_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    base = fetch_one(
        conn,
        f"SELECT {_COLS}, t.Description AS description FROM TOPIC t {_STATS} WHERE t.Topic_ID = :id",
        {"id": topic_id},
    )
    if base is None:
        raise HTTPException(404, "Topic not found")
    parent = None
    if base["parent_topic_id"] is not None:
        parent = fetch_one(conn, f"SELECT {_COLS} FROM TOPIC t {_STATS} WHERE t.Topic_ID = :id", {"id": base["parent_topic_id"]})
    children = fetch_all(
        conn,
        f"SELECT {_COLS} FROM TOPIC t {_STATS} WHERE t.Parent_Topic_ID = :id ORDER BY paper_count DESC, t.Topic_Name",
        {"id": topic_id},
    )
    return {**base, "parent": parent, "children": children}


@router.get("/{topic_id}/counts")
def topic_counts(topic_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    """M1 placeholder kept for compatibility; /topics/{id} and
    /papers?topic_id= supersede it."""
    row = conn.execute(
        text(
            "SELECT t.Topic_Name, COUNT(DISTINCT pt.Paper_ID) FROM TOPIC t "
            "LEFT JOIN PAPER_TOPIC pt ON pt.Topic_ID = t.Topic_ID WHERE t.Topic_ID = :id GROUP BY t.Topic_Name"
        ),
        {"id": topic_id},
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Topic not found")
    return {"topic_name": row[0], "paper_count": row[1]}
