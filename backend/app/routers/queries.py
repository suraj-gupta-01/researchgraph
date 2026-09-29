"""
G6 -- the PRD Section 9 demo queries (M6 evaluation prep), for the frontend's
Query lab.

Each query is a SQL view or stored function from
database/migrations/06_query_lab.sql (or, for the recursive citation chain,
the CTE /papers/{id}/citation-chain already runs), wrapped by a thin
endpoint whose SELECT is a module constant. /queries/catalog returns, for
every query, the statement the endpoint executes and the definitions of the
database objects it reads, fetched live from Postgres (pg_get_viewdef /
pg_get_functiondef) rather than copied, so what the evaluator reads is what
runs.

All user input is bound; nothing from the request is interpolated into SQL.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.db import get_conn
from app.routers.papers import _CHAIN
from app.schemas import (
    CrossCommunityCitation,
    InstitutionTopicCollaboration,
    Page,
    QueryCatalogEntry,
    TopicAuthorRow,
    TopicYearCount,
)
from app.sqlutil import PageParams, fetch_all, fetch_one, page, page_params

router = APIRouter(prefix="/queries", tags=["queries (Section 9)"])

TopicId = Annotated[int, Query(ge=1, le=2_147_483_647)]
Year = Annotated[int, Query(ge=1900, le=2100)]

# ---- the statements the endpoints run -------------------------------------

CROSS_COMMUNITY_SQL = """
SELECT x.Citing_Paper_ID AS citing_paper_id, pf.Title AS citing_title, pf.Publication_Year AS citing_year,
       x.Citing_Community_ID AS citing_community_id, cf.Label AS citing_community_label,
       x.Cited_Paper_ID AS cited_paper_id, pt.Title AS cited_title, pt.Publication_Year AS cited_year,
       x.Cited_Community_ID AS cited_community_id, ct.Label AS cited_community_label
FROM v_cross_community_citation x
JOIN PAPER pf ON pf.Paper_ID = x.Citing_Paper_ID
JOIN PAPER pt ON pt.Paper_ID = x.Cited_Paper_ID
JOIN RESEARCH_COMMUNITY cf ON cf.Community_ID = x.Citing_Community_ID
JOIN RESEARCH_COMMUNITY ct ON ct.Community_ID = x.Cited_Community_ID
WHERE (CAST(:community_id AS INTEGER) IS NULL
       OR :community_id IN (x.Citing_Community_ID, x.Cited_Community_ID))
ORDER BY pf.Publication_Year DESC, x.Citing_Paper_ID, x.Cited_Paper_ID
LIMIT :limit OFFSET :offset
"""
CROSS_COMMUNITY_COUNT_SQL = """
SELECT COUNT(*) FROM v_cross_community_citation x
WHERE (CAST(:community_id AS INTEGER) IS NULL
       OR :community_id IN (x.Citing_Community_ID, x.Cited_Community_ID))
"""

_SPANNING_CTE = """
WITH spanning AS (   -- collaborations on papers tagged with BOTH topics
    SELECT Institution_A_ID, Institution_B_ID, Paper_ID
    FROM v_institution_topic_collaboration
    WHERE Topic_ID IN (:topic_a, :topic_b) AND Relevance_Score >= :min_relevance
    GROUP BY Institution_A_ID, Institution_B_ID, Paper_ID
    HAVING COUNT(DISTINCT Topic_ID) = 2
)"""
INSTITUTION_TOPIC_COUNT_SQL = _SPANNING_CTE + """
SELECT COUNT(DISTINCT (Institution_A_ID, Institution_B_ID)) FROM spanning
"""
INSTITUTION_TOPIC_SQL = _SPANNING_CTE + """
SELECT s.Institution_A_ID AS institution_a_id, ia.Institution_Name AS institution_a_name, ia.Country AS institution_a_country,
       s.Institution_B_ID AS institution_b_id, ib.Institution_Name AS institution_b_name, ib.Country AS institution_b_country,
       COUNT(*) AS shared_papers,
       (ARRAY_AGG(s.Paper_ID ORDER BY s.Paper_ID))[1:5] AS example_paper_ids,
       COUNT(*) OVER () AS total
FROM spanning s
JOIN INSTITUTION ia ON ia.Institution_ID = s.Institution_A_ID
JOIN INSTITUTION ib ON ib.Institution_ID = s.Institution_B_ID
GROUP BY s.Institution_A_ID, ia.Institution_Name, ia.Country, s.Institution_B_ID, ib.Institution_Name, ib.Country
ORDER BY shared_papers DESC, ia.Institution_Name, ib.Institution_Name
LIMIT :limit OFFSET :offset
"""

TOPIC_AUTHORS_SQL = """
SELECT author_id, full_name, paper_count, first_year, last_year, institutions,
       COUNT(*) OVER () AS total
FROM fn_topic_authors(:topic_id, :year_from, :year_to, :min_relevance)
ORDER BY paper_count DESC, full_name, author_id
LIMIT :limit OFFSET :offset
"""

TOPIC_YEAR_SQL = """
SELECT Publication_Year AS year, paper_count, citation_count
FROM v_topic_year_counts
WHERE Topic_ID = :topic_id
ORDER BY Publication_Year
"""

_CATALOG = [
    {
        "key": "topic-authors",
        "title": "Authors on a topic in a year range, with institutions",
        "prd_text": "Find all authors who published on Federated Learning between 2023-2025, with their institutions.",
        "kind": "stored function + joins",
        "endpoint": "GET /queries/topic-authors",
        "statement": TOPIC_AUTHORS_SQL,
        "objects": [("function", "fn_topic_authors")],
    },
    {
        "key": "cross-community-citations",
        "title": "Papers citing papers from a different research community",
        "prd_text": "Find papers that cite papers from a different research community.",
        "kind": "views + joins",
        "endpoint": "GET /queries/cross-community-citations",
        "statement": CROSS_COMMUNITY_SQL,
        "objects": [("view", "v_cross_community_citation"), ("view", "v_paper_community")],
    },
    {
        "key": "institution-topic-collaboration",
        "title": "Institutions collaborating on papers spanning two topics",
        "prd_text": "Find institutions that collaborated on papers spanning two different topics.",
        "kind": "view + CTE + aggregation",
        "endpoint": "GET /queries/institution-topic-collaboration",
        "statement": INSTITUTION_TOPIC_SQL,
        "objects": [("view", "v_institution_topic_collaboration")],
    },
    {
        "key": "topic-year-counts",
        "title": "Papers per year for a topic",
        "prd_text": "Aggregation: Publication_Year -> COUNT(*) per topic.",
        "kind": "view (GROUP BY aggregation)",
        "endpoint": "GET /queries/topic-year-counts",
        "statement": TOPIC_YEAR_SQL,
        "objects": [("view", "v_topic_year_counts")],
    },
    {
        "key": "citation-chain",
        "title": "Recursive citation chain",
        "prd_text": "Recursive traversal of citation chains (Paper A -> B -> C -> D).",
        "kind": "recursive CTE",
        "endpoint": "GET /papers/{paper_id}/citation-chain",
        "statement": _CHAIN["cites"],
        "objects": [],
    },
]


def _topic_exists(conn: Connection, topic_id: int) -> None:
    if fetch_one(conn, "SELECT 1 AS x FROM TOPIC WHERE Topic_ID = :id", {"id": topic_id}) is None:
        raise HTTPException(404, f"Topic {topic_id} not found")


def _strip_total(rows: list[dict]) -> tuple[list[dict], int | None]:
    total = rows[0]["total"] if rows else None
    for r in rows:
        r.pop("total", None)
    return rows, total


@router.get("/catalog", response_model=list[QueryCatalogEntry])
def catalog(conn: Annotated[Connection, Depends(get_conn)]):
    """Every Section 9 query: the PRD sentence it answers, the endpoint, the
    exact statement that endpoint executes, and the live definitions of the
    views/functions it reads."""
    out = []
    for entry in _CATALOG:
        objects = []
        for kind, name in entry["objects"]:
            sql = (
                "SELECT pg_get_viewdef(CAST(:n AS regclass), true) AS d"
                if kind == "view"
                else "SELECT pg_get_functiondef(CAST(:n AS regproc)) AS d"
            )
            row = fetch_one(conn, sql, {"n": name})
            objects.append({"kind": kind, "name": name, "definition": (row or {}).get("d") or ""})
        out.append({**{k: v for k, v in entry.items() if k != "objects"}, "statement": entry["statement"].strip(), "objects": objects})
    return out


@router.get("/cross-community-citations", response_model=Page[CrossCommunityCitation])
def cross_community_citations(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    community_id: Annotated[int | None, Query(ge=1, le=2_147_483_647)] = None,
):
    """Citations whose citing and cited papers belong to different research
    communities (a paper's community = its authors' majority community).
    Empty until graph.communities has run. `community_id` keeps citations
    into or out of one community."""
    params = {"community_id": community_id}
    total = conn.execute(text(CROSS_COMMUNITY_COUNT_SQL), params).scalar_one()
    items = fetch_all(conn, CROSS_COMMUNITY_SQL, {**params, "limit": p.limit, "offset": p.offset})
    return page(items, total, p)


@router.get("/institution-topic-collaboration", response_model=Page[InstitutionTopicCollaboration])
def institution_topic_collaboration(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    topic_a: TopicId,
    topic_b: TopicId,
    min_relevance: Annotated[float, Query(ge=0, le=1)] = 0.3,
):
    """Institution pairs that co-authored papers tagged with both topics
    (each at relevance >= min_relevance), ranked by how many such papers."""
    if topic_a == topic_b:
        raise HTTPException(422, "topic_a and topic_b must be different topics")
    _topic_exists(conn, topic_a)
    _topic_exists(conn, topic_b)
    rows = fetch_all(conn, INSTITUTION_TOPIC_SQL, {
        "topic_a": topic_a, "topic_b": topic_b, "min_relevance": min_relevance,
        "limit": p.limit, "offset": p.offset,
    })
    items, total = _strip_total(rows)
    if total is None:   # empty page: the window count had no row to ride on
        total = conn.execute(text(INSTITUTION_TOPIC_COUNT_SQL), {
            "topic_a": topic_a, "topic_b": topic_b, "min_relevance": min_relevance,
        }).scalar_one()
    return page(items, total, p)


@router.get("/topic-authors", response_model=Page[TopicAuthorRow])
def topic_authors(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    topic_id: TopicId,
    year_from: Year,
    year_to: Year,
    min_relevance: Annotated[float, Query(ge=0, le=1)] = 0.3,
):
    """Authors who published on the topic (or its sub-topics) between the two
    years inclusive, with every institution they were attributed to on
    those papers; most papers first."""
    if year_from > year_to:
        raise HTTPException(422, "year_from must not be after year_to")
    _topic_exists(conn, topic_id)
    params = {"topic_id": topic_id, "year_from": year_from, "year_to": year_to, "min_relevance": min_relevance}
    rows = fetch_all(conn, TOPIC_AUTHORS_SQL, {**params, "limit": p.limit, "offset": p.offset})
    items, total = _strip_total(rows)
    if total is None:   # empty page: the window count had no row to ride on
        total = conn.execute(
            text("SELECT COUNT(*) FROM fn_topic_authors(:topic_id, :year_from, :year_to, :min_relevance)"), params
        ).scalar_one()
    return page(items, total, p)


@router.get("/topic-year-counts", response_model=list[TopicYearCount])
def topic_year_counts(conn: Annotated[Connection, Depends(get_conn)], topic_id: TopicId):
    """Papers (and their citations) per publication year for one topic,
    grouped live from PAPER_TOPIC. Years with no papers have no row."""
    _topic_exists(conn, topic_id)
    return fetch_all(conn, TOPIC_YEAR_SQL, {"topic_id": topic_id})
