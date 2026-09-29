"""
F2 — research communities (M4 Part 1).

Read-only views over RESEARCH_COMMUNITY / COMMUNITY_MEMBER, which
`python -m graph.communities` fills. Without ?q= this lists every detected
community; with ?q= it answers F2's acceptance question — "for a searched
topic, the top communities with their members and a label" — by reusing the
F1 candidate search, so a topic search and its communities always agree on
which papers matched.

  matched_papers  = distinct query-matching papers written by >= 1 member
  matched_members = how many members wrote them
Communities are ranked by matched_papers, then size. A paper co-written across
communities counts for each of them; that is intended (it is what makes a
community a bridge).

Everything user-supplied is a bound parameter. The SQL fragments interpolated
below are module constants chosen by code path, never by request data.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app import mongo_store
from app import search as search_service
from app.db import get_conn
from app.schemas import CommunityDetail, CommunityGraph, CommunityMemberOut, CommunityPage, Page
from app.sqlutil import PageParams, fetch_all, fetch_one, page, page_params
from graph.build_graph import build_author_collaboration_graph

log = logging.getLogger("researchgraph.communities_api")

router = APIRouter(prefix="/communities", tags=["communities (F2)"])

CommunityId = Annotated[int, Path(ge=1, le=2_147_483_647)]

_COLS = """
    c.Community_ID AS community_id, c.Label AS label, c.Root_Topic_ID AS root_topic_id,
    t.Topic_Name AS root_topic_name, c.Algorithm AS algorithm, c.Detection_Date AS detection_date,
    sz.member_count AS member_count, COALESCE(pc.paper_count, 0) AS paper_count
"""
_FROM = """
FROM RESEARCH_COMMUNITY c
JOIN (SELECT Community_ID, COUNT(*) AS member_count FROM COMMUNITY_MEMBER GROUP BY Community_ID) sz
  ON sz.Community_ID = c.Community_ID
LEFT JOIN TOPIC t ON t.Topic_ID = c.Root_Topic_ID
LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT s.Paper_ID) AS paper_count
    FROM COMMUNITY_MEMBER cm JOIN AUTHORSHIP s ON s.Author_ID = cm.Author_ID
    WHERE cm.Community_ID = c.Community_ID
) pc ON TRUE
"""
_MATCHED_COLS = "m.matched_papers AS matched_papers, m.matched_members AS matched_members"
_MATCHED_JOIN = """
JOIN (
    SELECT cm.Community_ID, COUNT(DISTINCT s.Paper_ID) AS matched_papers, COUNT(DISTINCT s.Author_ID) AS matched_members
    FROM COMMUNITY_MEMBER cm JOIN AUTHORSHIP s ON s.Author_ID = cm.Author_ID
    WHERE s.Paper_ID = ANY(:ids)
    GROUP BY cm.Community_ID
) m ON m.Community_ID = c.Community_ID
"""

# One row per (community, member) with the member's corpus paper count.
_MEMBER_AGG = """
    SELECT cm.Community_ID AS community_id, a.Author_ID AS author_id, a.Full_Name AS full_name,
           cm.Membership_Score::float8 AS membership_score, COUNT(s.Paper_ID) AS paper_count
    FROM COMMUNITY_MEMBER cm
    JOIN AUTHOR a ON a.Author_ID = cm.Author_ID
    LEFT JOIN AUTHORSHIP s ON s.Author_ID = a.Author_ID
    WHERE cm.Community_ID = ANY(:cids)
    GROUP BY cm.Community_ID, a.Author_ID, a.Full_Name, cm.Membership_Score
"""
_MEMBER_ORDER = "g.paper_count DESC, g.membership_score DESC NULLS LAST, g.full_name, g.author_id"


def _top_members(conn: Connection, community_ids: list[int], n: int) -> dict[int, list[dict]]:
    """The n most-published members of each community, in one query."""
    if not community_ids or n == 0:
        return {}
    rows = fetch_all(
        conn,
        f"""
        SELECT r.community_id, r.author_id, r.full_name, r.membership_score, r.paper_count
        FROM (
            SELECT g.*, ROW_NUMBER() OVER (PARTITION BY g.community_id ORDER BY {_MEMBER_ORDER}) AS rn
            FROM ({_MEMBER_AGG}) g
        ) r
        WHERE r.rn <= :n
        ORDER BY r.community_id, r.rn
        """,
        {"cids": community_ids, "n": n},
    )
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r["community_id"], []).append({k: v for k, v in r.items() if k != "community_id"})
    return out


def _evidence(community_id: int, detection_date: datetime) -> tuple[list[dict], str]:
    """Label evidence (the scored topics behind a community's label) from the
    Mongo run snapshot. Postgres is authoritative for which communities exist,
    so evidence is only returned when the snapshot is from the same run
    (its detected_at equals RESEARCH_COMMUNITY.Detection_Date)."""
    try:
        snap = mongo_store.community_snapshot()
    except Exception:                    # noqa: BLE001 - evidence is optional
        log.warning("Could not read community snapshot from MongoDB", exc_info=True)
        return [], "unavailable"
    if snap is None:
        return [], "missing"
    try:
        same_run = datetime.fromisoformat(snap["detected_at"]) == detection_date
    except (KeyError, TypeError, ValueError):
        same_run = False
    if not same_run:
        return [], "stale"
    for c in snap.get("communities", []):
        if c.get("community_id") == community_id:
            return list(c.get("topics", [])), "ok"
    return [], "stale"


@router.get("", response_model=CommunityPage)
def list_communities(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    q: Annotated[str | None, Query(min_length=1, max_length=200, description="Free-text topic (F1 search)")] = None,
    top_members: Annotated[int, Query(ge=0, le=20, description="Members to include per community")] = 5,
):
    """Detected communities, largest first; with `q`, only those that wrote
    papers matching the topic, ranked by how many."""
    q = (q or "").strip() or None
    meta = None
    page_args = {"limit": p.limit, "offset": p.offset}

    if q is None:
        total = conn.execute(text("SELECT COUNT(*) FROM RESEARCH_COMMUNITY")).scalar_one()
        items = fetch_all(
            conn,
            f"SELECT {_COLS} {_FROM} ORDER BY sz.member_count DESC, c.Community_ID LIMIT :limit OFFSET :offset",
            page_args,
        )
    else:
        cand = search_service.collect_candidates(conn, q)
        meta = {"mongo": cand.mongo, "matched_via": cand.matched_via, "truncated": cand.truncated}
        ids = list(cand.relevance)
        if not ids:
            total, items = 0, []
        else:
            total = conn.execute(text(f"SELECT COUNT(*) FROM RESEARCH_COMMUNITY c {_MATCHED_JOIN}"), {"ids": ids}).scalar_one()
            items = fetch_all(
                conn,
                f"SELECT {_COLS}, {_MATCHED_COLS} {_FROM} {_MATCHED_JOIN} "
                "ORDER BY m.matched_papers DESC, sz.member_count DESC, c.Community_ID LIMIT :limit OFFSET :offset",
                {"ids": ids, **page_args},
            )

    members = _top_members(conn, [i["community_id"] for i in items], top_members)
    for i in items:
        i["top_members"] = members.get(i["community_id"], [])
    return {**page(items, total, p), "query": q, "search_meta": meta}


_GRAPH_NODE_COLS = """
    SELECT a.Author_ID AS author_id,
           cm.Community_ID AS community_id, cm.Membership_Score::float8 AS membership_score,
           COALESCE(st.paper_count, 0) AS paper_count,
           ai.Bridge_Score::float8 AS bridge_score, ai.Communities_Touched AS communities_touched
    FROM AUTHOR a
    LEFT JOIN COMMUNITY_MEMBER cm ON cm.Author_ID = a.Author_ID
    LEFT JOIN AUTHOR_INFLUENCE ai ON ai.Author_ID = a.Author_ID
    LEFT JOIN LATERAL (SELECT COUNT(*) AS paper_count FROM AUTHORSHIP s WHERE s.Author_ID = a.Author_ID) st ON TRUE
    WHERE a.Author_ID = ANY(:ids)
"""


@router.get("/graph", response_model=CommunityGraph)
def community_graph(
    conn: Annotated[Connection, Depends(get_conn)],
    q: Annotated[str | None, Query(min_length=1, max_length=200, description="Free-text topic (F1 search)")] = None,
    min_weight: Annotated[float, Query(ge=0.0, description="Drop edges below this combined weight")] = 0.0,
    max_nodes: Annotated[int, Query(ge=1, le=2000, description="Cap on nodes, kept by weighted degree")] = 400,
):
    """The G1 community graph (design-system.md §6): the same author-author
    collaboration graph `python -m graph.communities` partitions
    (`build_author_collaboration_graph`, F2's four edge signals), so a node's
    community_id here always matches what /communities reports -- this never
    recomputes or approximates the partition. Building the graph needs no
    prior run: with no Louvain run yet every node's community_id and
    membership_score are None (design-system.md's "unassigned, grey"), and
    with no `graph.influence` run bridge_score/communities_touched are None
    too, the same "not computed" convention as every other F2/F4 field.

    Isolated authors (no qualifying edge, after `min_weight` and any `q`
    restriction) are left out: a graph view has nothing to draw for a point
    with no edges, and they would only crowd out real structure once
    `max_nodes` is reached. `total_candidates` counts every author who does
    have >= 1 qualifying edge, before the cap; `truncated` says whether the
    cap actually cut anyone.
    """
    q_clean = (q or "").strip() or None
    meta = None

    graph = build_author_collaboration_graph()

    if q_clean is not None:
        cand = search_service.collect_candidates(conn, q_clean)
        meta = {"mongo": cand.mongo, "matched_via": cand.matched_via, "truncated": cand.truncated}
        paper_ids = list(cand.relevance)
        allowed = set()
        if paper_ids:
            allowed = {r[0] for r in conn.execute(text("SELECT DISTINCT Author_ID FROM AUTHORSHIP WHERE Paper_ID = ANY(:ids)"), {"ids": paper_ids}).all()}
        graph = graph.subgraph(allowed & set(graph.nodes)).copy()

    if min_weight > 0:
        weak = [(u, v) for u, v, w in graph.edges(data="weight") if (w or 0.0) < min_weight]
        graph.remove_edges_from(weak)
    graph.remove_nodes_from([n for n, deg in graph.degree() if deg == 0])

    total_candidates = graph.number_of_nodes()
    ranked = sorted(graph.nodes, key=lambda n: graph.degree(n, weight="weight"), reverse=True)
    kept_ids = ranked[:max_nodes]
    truncated = total_candidates > len(kept_ids)
    sub = graph.subgraph(kept_ids)

    attrs = {r["author_id"]: r for r in fetch_all(conn, _GRAPH_NODE_COLS, {"ids": kept_ids})} if kept_ids else {}
    _defaults = {"community_id": None, "membership_score": None, "paper_count": 0, "bridge_score": None, "communities_touched": None}
    nodes = [
        {
            "author_id": aid,
            "full_name": sub.nodes[aid].get("label", f"Author {aid}"),
            **{k: v for k, v in attrs.get(aid, _defaults).items() if k != "author_id"},
        }
        for aid in kept_ids
    ]
    edges = [
        {
            "source": u,
            "target": v,
            "weight": d.get("weight", 0.0),
            "signals": {
                "coauthor": d.get("coauthor_weight", 0.0),
                "citation": d.get("citation_weight", 0.0),
                "topic": d.get("shared_topic_weight", 0.0),
                "institution": d.get("institutional_weight", 0.0),
            },
        }
        for u, v, d in sub.edges(data=True)
    ]

    run = fetch_one(conn, "SELECT Algorithm AS algorithm, Detection_Date AS detection_date FROM RESEARCH_COMMUNITY ORDER BY Detection_Date DESC LIMIT 1")
    return {
        "nodes": nodes,
        "edges": edges,
        "algorithm": run["algorithm"] if run else None,
        "detection_date": run["detection_date"] if run else None,
        "total_candidates": total_candidates,
        "truncated": truncated,
        "query": q_clean,
        "search_meta": meta,
    }


@router.get("/{community_id}", response_model=CommunityDetail)
def community_detail(
    community_id: CommunityId,
    conn: Annotated[Connection, Depends(get_conn)],
    top_members: Annotated[int, Query(ge=0, le=50)] = 10,
):
    """One community: label, top members, member institutions, the year span of
    its papers, and the scored topics behind its label."""
    base = fetch_one(conn, f"SELECT {_COLS} {_FROM} WHERE c.Community_ID = :id", {"id": community_id})
    if base is None:
        raise HTTPException(404, "Community not found")

    years = conn.execute(
        text(
            """
            SELECT MIN(p.Publication_Year), MAX(p.Publication_Year) FROM PAPER p
            WHERE p.Paper_ID IN (
                SELECT s.Paper_ID FROM AUTHORSHIP s JOIN COMMUNITY_MEMBER cm ON cm.Author_ID = s.Author_ID
                WHERE cm.Community_ID = :id
            )
            """
        ),
        {"id": community_id},
    ).one()
    institutions = fetch_all(
        conn,
        """
        SELECT i.Institution_ID AS institution_id, i.Institution_Name AS name, i.Country AS country,
               COUNT(DISTINCT cm.Author_ID) AS member_count
        FROM COMMUNITY_MEMBER cm
        JOIN AUTHOR_INSTITUTION ai ON ai.Author_ID = cm.Author_ID
        JOIN INSTITUTION i ON i.Institution_ID = ai.Institution_ID
        WHERE cm.Community_ID = :id
        GROUP BY i.Institution_ID, i.Institution_Name, i.Country
        ORDER BY member_count DESC, i.Institution_Name LIMIT 8
        """,
        {"id": community_id},
    )
    topics, topics_status = _evidence(community_id, base["detection_date"])
    return {
        **base,
        "year_min": years[0], "year_max": years[1],
        "top_institutions": institutions,
        "topics": topics, "topics_status": topics_status,
        "top_members": _top_members(conn, [community_id], top_members).get(community_id, []),
    }


@router.get("/{community_id}/members", response_model=Page[CommunityMemberOut])
def community_members(
    community_id: CommunityId,
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
):
    """All members, most-published first (ties: most embedded, then name)."""
    if fetch_one(conn, "SELECT 1 AS present FROM RESEARCH_COMMUNITY WHERE Community_ID = :id", {"id": community_id}) is None:
        raise HTTPException(404, "Community not found")
    total = conn.execute(
        text("SELECT COUNT(*) FROM COMMUNITY_MEMBER WHERE Community_ID = :id"), {"id": community_id}
    ).scalar_one()
    items = fetch_all(
        conn,
        f"SELECT g.author_id, g.full_name, g.membership_score, g.paper_count FROM ({_MEMBER_AGG}) g "
        f"ORDER BY {_MEMBER_ORDER} LIMIT :limit OFFSET :offset",
        {"cids": [community_id], "limit": p.limit, "offset": p.offset},
    )
    return page(items, total, p)
