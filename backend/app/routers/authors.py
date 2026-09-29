from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app import search as search_service
from app.db import get_conn
from app.schemas import AuthorDetail, AuthorInfluence, AuthorSummary, BridgeAuthor, BridgePage, Page
from app.sqlutil import PageParams, fetch_all, fetch_one, like_pattern, page, page_params
from graph.influence import MIN_COMMUNITIES_FOR_BRIDGE

router = APIRouter(prefix="/authors", tags=["authors"])

_SORTS = {
    "papers": "paper_count DESC, total_citations DESC, a.Full_Name, a.Author_ID",
    "citations": "total_citations DESC, paper_count DESC, a.Full_Name, a.Author_ID",
    "name": "a.Full_Name ASC, a.Author_ID",
}
_STATS = """
    LEFT JOIN LATERAL (
        SELECT COUNT(*) AS paper_count, COALESCE(SUM(pp.Citation_Count), 0) AS total_citations
        FROM AUTHORSHIP s JOIN PAPER pp ON pp.Paper_ID = s.Paper_ID
        WHERE s.Author_ID = a.Author_ID
    ) st ON TRUE
"""


@router.get("", response_model=Page[AuthorSummary])
def list_authors(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    q: Annotated[str | None, Query(min_length=1, max_length=100, description="Name contains")] = None,
    institution_id: Annotated[int | None, Query(ge=1)] = None,
    sort: Literal["papers", "citations", "name"] = "papers",
):
    where, params = [], {}
    if q:
        where.append("a.Full_Name ILIKE :pat ESCAPE '\\'")
        params["pat"] = like_pattern(q.strip())
    if institution_id is not None:
        where.append("EXISTS (SELECT 1 FROM AUTHOR_INSTITUTION ai WHERE ai.Author_ID = a.Author_ID AND ai.Institution_ID = :inst)")
        params["inst"] = institution_id
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    total = conn.execute(text(f"SELECT COUNT(*) FROM AUTHOR a {where_sql}"), params).scalar_one()
    items = fetch_all(
        conn,
        f"SELECT a.Author_ID AS author_id, a.Full_Name AS full_name, a.ORCID AS orcid, "
        f"       COALESCE(st.paper_count, 0) AS paper_count, COALESCE(st.total_citations, 0) AS total_citations "
        f"FROM AUTHOR a {_STATS} {where_sql} ORDER BY {_SORTS[sort]} LIMIT :limit OFFSET :offset",
        {**params, "limit": p.limit, "offset": p.offset},
    )
    return page(items, total, p)


_INFLUENCE_COLS = """
    ai.Author_ID AS author_id, a.Full_Name AS full_name,
    ai.Degree_Centrality::float8 AS degree_centrality,
    ai.Betweenness_Centrality::float8 AS betweenness_centrality,
    ai.Pagerank::float8 AS pagerank, ai.Bridge_Score::float8 AS bridge_score,
    ai.Communities_Touched AS communities_touched, ai.Algorithm AS algorithm, ai.Detection_Date AS detection_date
"""
_INFLUENCE_FROM = "FROM AUTHOR_INFLUENCE ai JOIN AUTHOR a ON a.Author_ID = ai.Author_ID"


def _ties_for(conn: Connection, author_ids: list[int]) -> dict[int, list[dict]]:
    """Every AUTHOR_COMMUNITY_TIE row for these authors, largest tie first --
    the evidence behind each author's bridge_score (F4). `label` is looked up
    live against RESEARCH_COMMUNITY rather than cached on the tie row, so a
    community relabeled by a later `graph.communities` run (without a
    `graph.influence` re-run) is reflected immediately; a community deleted
    entirely takes its ties with it via ON DELETE CASCADE, so `label` is
    never actually missing in practice, but the LEFT JOIN keeps this
    endpoint correct even if a future run orders things differently."""
    if not author_ids:
        return {}
    rows = fetch_all(
        conn,
        """
        SELECT act.Author_ID AS author_id, act.Community_ID AS community_id, rc.Label AS label,
               act.Tie_Weight::float8 AS weight, act.Tie_Share::float8 AS share
        FROM AUTHOR_COMMUNITY_TIE act
        LEFT JOIN RESEARCH_COMMUNITY rc ON rc.Community_ID = act.Community_ID
        WHERE act.Author_ID = ANY(:ids)
        ORDER BY act.Author_ID, act.Tie_Weight DESC
        """,
        {"ids": author_ids},
    )
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r["author_id"], []).append({k: v for k, v in r.items() if k != "author_id"})
    return out


@router.get("/bridges", response_model=BridgePage)
def list_bridge_authors(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    q: Annotated[str | None, Query(min_length=1, max_length=200, description="Free-text topic (F1 search)")] = None,
    min_communities: Annotated[int, Query(ge=1, le=20, description="F4's own bar is 2: connecting >= 2 communities")] = MIN_COMMUNITIES_FOR_BRIDGE,
):
    """F4 -- researcher influence & bridge detection. Populated by
    `python -m graph.influence`; empty until it (and `graph.communities`
    before it) has run.

    Without `q`: every author touching `min_communities` (default 2) or more
    of the currently detected communities, ranked by bridge_score (the
    participation coefficient -- see graph/influence_core.py), then PageRank.

    With `q`: F4's acceptance case -- "for a searched topic, the system lists
    researchers who publish across the topic's detected communities, ranked
    by bridge score". Reuses F1's candidate search to find the communities
    the topic matches (same join `/communities?q=` uses), then keeps only
    authors bridging `min_communities`+ of THOSE communities specifically,
    ranked by how many of the matched communities they bridge, then overall
    bridge_score. `matched_communities` on each result is that count;
    `communities_touched` stays the author's overall count across every
    detected community, for context.
    """
    q = (q or "").strip() or None
    algorithm = conn.execute(text("SELECT Algorithm FROM AUTHOR_INFLUENCE LIMIT 1")).scalar_one_or_none()
    page_args = {"limit": p.limit, "offset": p.offset}
    meta = None

    if q is None:
        total = conn.execute(
            text("SELECT COUNT(*) FROM AUTHOR_INFLUENCE WHERE Communities_Touched >= :min_c"),
            {"min_c": min_communities},
        ).scalar_one()
        items = fetch_all(
            conn,
            f"""
            SELECT {_INFLUENCE_COLS}, COALESCE(st.paper_count, 0) AS paper_count
            {_INFLUENCE_FROM} {_STATS}
            WHERE ai.Communities_Touched >= :min_c
            ORDER BY ai.Bridge_Score DESC, ai.Pagerank DESC, ai.Author_ID
            LIMIT :limit OFFSET :offset
            """,
            {"min_c": min_communities, **page_args},
        )
    else:
        cand = search_service.collect_candidates(conn, q)
        meta = {"mongo": cand.mongo, "matched_via": cand.matched_via, "truncated": cand.truncated}
        paper_ids = list(cand.relevance)
        matched_community_ids = (
            [
                r[0]
                for r in conn.execute(
                    text(
                        "SELECT DISTINCT cm.Community_ID FROM COMMUNITY_MEMBER cm "
                        "JOIN AUTHORSHIP s ON s.Author_ID = cm.Author_ID WHERE s.Paper_ID = ANY(:ids)"
                    ),
                    {"ids": paper_ids},
                )
            ]
            if paper_ids
            else []
        )
        if not matched_community_ids:
            total, items = 0, []
        else:
            matched_sql = """
                SELECT act.Author_ID AS author_id, COUNT(DISTINCT act.Community_ID) AS matched_communities
                FROM AUTHOR_COMMUNITY_TIE act
                WHERE act.Community_ID = ANY(:cids)
                GROUP BY act.Author_ID
                HAVING COUNT(DISTINCT act.Community_ID) >= :min_c
            """
            match_params = {"cids": matched_community_ids, "min_c": min_communities}
            total = conn.execute(text(f"SELECT COUNT(*) FROM ({matched_sql}) c"), match_params).scalar_one()
            items = fetch_all(
                conn,
                f"""
                SELECT {_INFLUENCE_COLS}, COALESCE(st.paper_count, 0) AS paper_count, m.matched_communities AS matched_communities
                FROM ({matched_sql}) m
                JOIN AUTHOR_INFLUENCE ai ON ai.Author_ID = m.author_id
                JOIN AUTHOR a ON a.Author_ID = ai.Author_ID
                {_STATS}
                ORDER BY m.matched_communities DESC, ai.Bridge_Score DESC, ai.Pagerank DESC, ai.Author_ID
                LIMIT :limit OFFSET :offset
                """,
                {**match_params, **page_args},
            )

    ties = _ties_for(conn, [i["author_id"] for i in items])
    for i in items:
        i["ties"] = ties.get(i["author_id"], [])
    return {**page(items, total, p), "query": q, "search_meta": meta, "algorithm": algorithm}


@router.get("/{author_id}", response_model=AuthorDetail)
def author_detail(author_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    base = fetch_one(
        conn,
        f"SELECT a.Author_ID AS author_id, a.Full_Name AS full_name, a.ORCID AS orcid, "
        f"       a.Openalex_Author_ID AS openalex_author_id, a.Semantic_Scholar_Author_ID AS semantic_scholar_author_id, "
        f"       COALESCE(st.paper_count, 0) AS paper_count, COALESCE(st.total_citations, 0) AS total_citations "
        f"FROM AUTHOR a {_STATS} WHERE a.Author_ID = :id",
        {"id": author_id},
    )
    if base is None:
        raise HTTPException(404, "Author not found")

    institutions = fetch_all(
        conn,
        """
        SELECT i.Institution_ID AS institution_id, i.Institution_Name AS name, i.Country AS country,
               MIN(ai.Start_Year) AS first_year, MAX(ai.Start_Year) AS last_year
        FROM AUTHOR_INSTITUTION ai JOIN INSTITUTION i ON i.Institution_ID = ai.Institution_ID
        WHERE ai.Author_ID = :id
        GROUP BY i.Institution_ID, i.Institution_Name, i.Country
        ORDER BY MAX(ai.Start_Year) DESC NULLS LAST, i.Institution_Name
        """,
        {"id": author_id},
    )
    coauthors = fetch_all(
        conn,
        """
        SELECT a2.Author_ID AS author_id, a2.Full_Name AS full_name, COUNT(*) AS shared_papers
        FROM AUTHORSHIP s1
        JOIN AUTHORSHIP s2 ON s2.Paper_ID = s1.Paper_ID AND s2.Author_ID <> s1.Author_ID
        JOIN AUTHOR a2 ON a2.Author_ID = s2.Author_ID
        WHERE s1.Author_ID = :id
        GROUP BY a2.Author_ID, a2.Full_Name
        ORDER BY shared_papers DESC, a2.Full_Name LIMIT 10
        """,
        {"id": author_id},
    )
    by_year = fetch_all(
        conn,
        "SELECT pp.Publication_Year AS year, COUNT(*) AS paper_count FROM AUTHORSHIP s "
        "JOIN PAPER pp ON pp.Paper_ID = s.Paper_ID WHERE s.Author_ID = :id "
        "GROUP BY pp.Publication_Year ORDER BY pp.Publication_Year",
        {"id": author_id},
    )
    return {**base, "institutions": institutions, "coauthors": coauthors, "papers_by_year": by_year}


@router.get("/{author_id}/influence", response_model=AuthorInfluence)
def author_influence(author_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    """One author's F4 profile: the three centrality metrics, the bridge
    score (participation coefficient), and the per-community ties that
    score is computed from. Populated by `python -m graph.influence`."""
    if fetch_one(conn, "SELECT 1 AS present FROM AUTHOR WHERE Author_ID = :id", {"id": author_id}) is None:
        raise HTTPException(404, "Author not found")
    base = fetch_one(conn, f"SELECT {_INFLUENCE_COLS} {_INFLUENCE_FROM} WHERE ai.Author_ID = :id", {"id": author_id})
    if base is None:
        raise HTTPException(404, "No influence score for this author yet -- has graph.influence run?")
    return {**base, "ties": _ties_for(conn, [author_id]).get(author_id, [])}
