from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.db import get_conn
from app.schemas import Collaborator, CountryBreakdownOut, InstitutionDetail, InstitutionNetwork, InstitutionSummary, Page
from app.sqlutil import PageParams, fetch_all, fetch_one, like_pattern, page, page_params

router = APIRouter(prefix="/institutions", tags=["institutions"])

_SORTS = {
    "papers": "paper_count DESC, author_count DESC, i.Institution_Name, i.Institution_ID",
    "authors": "author_count DESC, paper_count DESC, i.Institution_Name, i.Institution_ID",
    "name": "i.Institution_Name ASC, i.Institution_ID",
}
_STATS = """
    LEFT JOIN (SELECT Institution_ID, COUNT(DISTINCT Paper_ID) AS paper_count
               FROM v_paper_institution GROUP BY Institution_ID) ps ON ps.Institution_ID = i.Institution_ID
    LEFT JOIN (SELECT Institution_ID, COUNT(DISTINCT Author_ID) AS author_count
               FROM AUTHOR_INSTITUTION GROUP BY Institution_ID) au ON au.Institution_ID = i.Institution_ID
"""
_COLS = (
    "i.Institution_ID AS institution_id, i.Institution_Name AS name, i.Country AS country, i.ROR_ID AS ror_id, "
    "COALESCE(ps.paper_count, 0) AS paper_count, COALESCE(au.author_count, 0) AS author_count"
)


@router.get("", response_model=Page[InstitutionSummary])
def list_institutions(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    country: Annotated[str | None, Query(min_length=2, max_length=100)] = None,
    sort: Literal["papers", "authors", "name"] = "papers",
):
    where, params = [], {}
    if q:
        where.append("i.Institution_Name ILIKE :pat ESCAPE '\\'")
        params["pat"] = like_pattern(q.strip())
    if country:
        where.append("i.Country = :country")
        params["country"] = country
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute(text(f"SELECT COUNT(*) FROM INSTITUTION i {where_sql}"), params).scalar_one()
    items = fetch_all(
        conn,
        f"SELECT {_COLS} FROM INSTITUTION i {_STATS} {where_sql} ORDER BY {_SORTS[sort]} LIMIT :limit OFFSET :offset",
        {**params, "limit": p.limit, "offset": p.offset},
    )
    return page(items, total, p)


@router.get("/countries", response_model=CountryBreakdownOut)
def institution_countries(
    conn: Annotated[Connection, Depends(get_conn)],
    limit: Annotated[int, Query(ge=1, le=300, description="Countries returned, most papers first")] = 50,
):
    """Top-institutions view (F6, Phase 7): institutions, papers and authors
    aggregated per country. Distinct counts, so a paper co-written by two
    institutions in one country counts once for it; a paper spanning two
    countries counts once for each (so the per-country paper counts can sum
    to more than total_papers, which counts it once overall)."""
    items = fetch_all(
        conn,
        """
        SELECT i.Country AS country,
               COUNT(DISTINCT i.Institution_ID) AS institution_count,
               COUNT(DISTINCT vi.Paper_ID) AS paper_count,
               COUNT(DISTINCT ai.Author_ID) AS author_count
        FROM INSTITUTION i
        LEFT JOIN v_paper_institution vi ON vi.Institution_ID = i.Institution_ID
        LEFT JOIN AUTHOR_INSTITUTION ai ON ai.Institution_ID = i.Institution_ID
        GROUP BY i.Country
        ORDER BY paper_count DESC, institution_count DESC, i.Country NULLS LAST
        LIMIT :limit
        """,
        {"limit": limit},
    )
    totals = fetch_one(
        conn,
        "SELECT (SELECT COUNT(*) FROM INSTITUTION) AS total_institutions, "
        "(SELECT COUNT(DISTINCT Paper_ID) FROM v_paper_institution) AS total_papers",
    )
    return {"items": items, **totals}


@router.get("/network", response_model=InstitutionNetwork)
def institution_network(
    conn: Annotated[Connection, Depends(get_conn)],
    limit: Annotated[int, Query(ge=2, le=500, description="Maximum institutions (nodes) returned")] = 150,
    min_shared: Annotated[int, Query(ge=1, le=1000, description="Drop pairs with fewer shared papers")] = 1,
    center_id: Annotated[int | None, Query(ge=1, le=2_147_483_647, description="Ego mode: this institution and its partners")] = None,
):
    """G5: the institution collaboration network (F6, Phase 7) in one request.

    Edges are COLLABORATION pairs aggregated to distinct shared papers, kept
    when shared_papers >= min_shared. Institutions with no qualifying edge are
    left out (the same isolated-node convention as the G1 and G2 graphs).
    Nodes are ranked by weighted degree (total shared papers), then paper
    count, and capped at `limit`; `truncated` reports the cap. Only edges with
    both ends kept are returned, so `collaborators`/`shared_papers` on a node
    describe the drawn graph, not the whole corpus.

    With `center_id` the network is the institution's ego network: the
    centre, its partners (ranked the same way, capped at limit - 1), and the
    partner-partner edges among them. 404 if the centre does not exist; an
    existing institution with no collaborations returns just its own node.

    Empty until ingestion.derive_collaboration has run (seed_dev and
    run_ingestion call it).
    """
    pairs_sql = """
        SELECT Institution_A_ID AS source, Institution_B_ID AS target, COUNT(DISTINCT Paper_ID) AS shared_papers
        FROM COLLABORATION GROUP BY Institution_A_ID, Institution_B_ID
        HAVING COUNT(DISTINCT Paper_ID) >= :min_shared
    """
    params: dict = {"min_shared": min_shared}
    if center_id is not None:
        if fetch_one(conn, "SELECT 1 AS x FROM INSTITUTION WHERE Institution_ID = :id", {"id": center_id}) is None:
            raise HTTPException(404, "Institution not found")
        # The ego's partners first, then every edge among {centre} + partners.
        partner_rows = fetch_all(
            conn,
            f"SELECT CASE WHEN source = :cid THEN target ELSE source END AS other_id, shared_papers "
            f"FROM ({pairs_sql}) p WHERE source = :cid OR target = :cid",
            {**params, "cid": center_id},
        )
        members = {center_id} | {r["other_id"] for r in partner_rows}
        edge_rows = fetch_all(
            conn,
            f"SELECT * FROM ({pairs_sql}) p WHERE source = ANY(:ids) AND target = ANY(:ids)",
            {**params, "ids": list(members)},
        )
    else:
        edge_rows = fetch_all(conn, pairs_sql, params)

    weighted: dict[int, int] = {}
    for e in edge_rows:
        weighted[e["source"]] = weighted.get(e["source"], 0) + e["shared_papers"]
        weighted[e["target"]] = weighted.get(e["target"], 0) + e["shared_papers"]
    if center_id is not None:
        weighted.setdefault(center_id, 0)

    info = {
        r["institution_id"]: r
        for r in fetch_all(
            conn,
            f"SELECT {_COLS} FROM INSTITUTION i {_STATS} WHERE i.Institution_ID = ANY(:ids)",
            {"ids": list(weighted)},
        )
    } if weighted else {}

    def rank(iid: int):
        return (-weighted[iid], -info[iid]["paper_count"], info[iid]["name"], iid)

    if center_id is not None:
        partners = sorted((i for i in weighted if i != center_id), key=rank)
        kept_ids = [center_id] + partners[: limit - 1]
    else:
        kept_ids = sorted(weighted, key=rank)[:limit]
    kept = set(kept_ids)
    edges = [
        {"source": e["source"], "target": e["target"], "shared_papers": e["shared_papers"]}
        for e in edge_rows
        if e["source"] in kept and e["target"] in kept
    ]
    degree: dict[int, int] = {i: 0 for i in kept_ids}
    strength: dict[int, int] = {i: 0 for i in kept_ids}
    for e in edges:
        for end in (e["source"], e["target"]):
            degree[end] += 1
            strength[end] += e["shared_papers"]
    nodes = [
        {
            "institution_id": i, "name": info[i]["name"], "country": info[i]["country"],
            "paper_count": info[i]["paper_count"], "collaborators": degree[i], "shared_papers": strength[i],
        }
        for i in kept_ids
    ]
    return {
        "nodes": nodes, "edges": edges, "center_id": center_id, "min_shared": min_shared,
        "total_candidates": len(weighted), "truncated": len(weighted) > len(kept_ids),
    }


@router.get("/{institution_id}", response_model=InstitutionDetail)
def institution_detail(institution_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    base = fetch_one(
        conn,
        f"SELECT {_COLS} FROM INSTITUTION i {_STATS} WHERE i.Institution_ID = :id",
        {"id": institution_id},
    )
    if base is None:
        raise HTTPException(404, "Institution not found")
    top_authors = fetch_all(
        conn,
        """
        SELECT a.Author_ID AS author_id, a.Full_Name AS full_name, COUNT(*) AS paper_count
        FROM AUTHOR_INSTITUTION ai
        JOIN AUTHOR a ON a.Author_ID = ai.Author_ID
        JOIN AUTHORSHIP s ON s.Author_ID = ai.Author_ID
        JOIN PAPER pp ON pp.Paper_ID = s.Paper_ID AND pp.Publication_Year = ai.Start_Year
        WHERE ai.Institution_ID = :id
        GROUP BY a.Author_ID, a.Full_Name
        ORDER BY paper_count DESC, a.Full_Name LIMIT 10
        """,
        {"id": institution_id},
    )
    by_year = fetch_all(
        conn,
        "SELECT pp.Publication_Year AS year, COUNT(*) AS paper_count FROM v_paper_institution vi "
        "JOIN PAPER pp ON pp.Paper_ID = vi.Paper_ID WHERE vi.Institution_ID = :id "
        "GROUP BY pp.Publication_Year ORDER BY pp.Publication_Year",
        {"id": institution_id},
    )
    return {**base, "top_authors": top_authors, "papers_by_year": by_year}


@router.get("/{institution_id}/collaborators", response_model=Page[Collaborator])
def institution_collaborators(
    institution_id: int,
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
):
    """Institutions that co-appear on papers with this one, by shared paper
    count (from COLLABORATION; run derive_collaboration after ingestion)."""
    if fetch_one(conn, "SELECT 1 AS x FROM INSTITUTION WHERE Institution_ID = :id", {"id": institution_id}) is None:
        raise HTTPException(404, "Institution not found")
    pair_rows = """
        SELECT Institution_B_ID AS other_id, Paper_ID FROM COLLABORATION WHERE Institution_A_ID = :id
        UNION ALL
        SELECT Institution_A_ID AS other_id, Paper_ID FROM COLLABORATION WHERE Institution_B_ID = :id
    """
    total = conn.execute(text(f"SELECT COUNT(DISTINCT other_id) FROM ({pair_rows}) c"), {"id": institution_id}).scalar_one()
    items = fetch_all(
        conn,
        f"""
        SELECT o.Institution_ID AS institution_id, o.Institution_Name AS name, o.Country AS country,
               COUNT(*) AS shared_papers
        FROM ({pair_rows}) c JOIN INSTITUTION o ON o.Institution_ID = c.other_id
        GROUP BY o.Institution_ID, o.Institution_Name, o.Country
        ORDER BY shared_papers DESC, o.Institution_Name, o.Institution_ID
        LIMIT :limit OFFSET :offset
        """,
        {"id": institution_id, "limit": p.limit, "offset": p.offset},
    )
    return page(items, total, p)
