"""
F1 topic exploration: turn a free-text topic into a ranked set of papers plus
the aggregates a dashboard needs (authors, institutions, venues, topics,
keywords, citation links).

Candidate generation unions three channels:
  title     Postgres full-text match on PAPER.Title (websearch syntax)
  topic     PAPER_TOPIC rows whose TOPIC name matches, including descendant
            topics (populated by ingestion.extract_topics as of M3)
  abstract  MongoDB text search over abstract + keywords

Relevance (documented, deliberately simple so it can be explained):
  relevance = 3 * [title hit] + 2 * [topic hit] + 1 * [abstract/keyword hit]
Ties break on citation count. Users can also sort by citations or year.

If MongoDB is unreachable the search degrades to the Postgres channels and
reports meta.mongo = "unavailable" instead of failing.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app import mongo_store
from app.sqlutil import fetch_all, like_pattern

log = logging.getLogger("researchgraph.search")

W_TITLE, W_TOPIC, W_ABSTRACT = 3.0, 2.0, 1.0
CANDIDATE_CAP = 2000


@dataclass
class Candidates:
    relevance: dict[int, float] = field(default_factory=dict)
    matched_via: dict[str, int] = field(default_factory=dict)
    mongo: str = "ok"
    truncated: bool = False


def collect_candidates(conn: Connection, q: str) -> Candidates:
    cand = Candidates()

    title_ids = [
        r[0]
        for r in conn.execute(
            text(
                "SELECT Paper_ID FROM PAPER WHERE Title_TSV @@ websearch_to_tsquery('english', :q) LIMIT :cap"
            ),
            {"q": q, "cap": CANDIDATE_CAP},
        )
    ]
    topic_ids = [
        r[0]
        for r in conn.execute(
            text(
                """
                WITH RECURSIVE matched(id) AS (
                    SELECT Topic_ID FROM TOPIC WHERE Topic_Name ILIKE :pat ESCAPE '\\'
                    UNION
                    SELECT t.Topic_ID FROM TOPIC t JOIN matched m ON t.Parent_Topic_ID = m.id
                )
                SELECT DISTINCT Paper_ID FROM PAPER_TOPIC
                WHERE Topic_ID IN (SELECT id FROM matched) LIMIT :cap
                """
            ),
            {"pat": like_pattern(q), "cap": CANDIDATE_CAP},
        )
    ]

    abstract_ids: list[int] = []
    if mongo_store.build_text_query(q) is None:
        cand.mongo = "skipped"          # query was only stopwords
    else:
        try:
            abstract_ids = list(mongo_store.text_search(q, CANDIDATE_CAP))
        except Exception:                # noqa: BLE001 - any Mongo failure must not break search
            log.warning("Mongo text search failed; continuing with Postgres channels", exc_info=True)
            cand.mongo = "unavailable"

    for pid in title_ids:
        cand.relevance[pid] = cand.relevance.get(pid, 0.0) + W_TITLE
    for pid in topic_ids:
        cand.relevance[pid] = cand.relevance.get(pid, 0.0) + W_TOPIC
    for pid in abstract_ids:
        cand.relevance[pid] = cand.relevance.get(pid, 0.0) + W_ABSTRACT

    cand.matched_via = {"title": len(title_ids), "topic": len(topic_ids), "abstract": len(abstract_ids)}
    cand.truncated = any(n >= CANDIDATE_CAP for n in cand.matched_via.values())
    return cand


def filtered_ids(
    conn: Connection,
    cand: Candidates,
    *,
    year_from: int | None = None,
    year_to: int | None = None,
    venue_id: int | None = None,
    author_id: int | None = None,
    institution_id: int | None = None,
) -> list[int]:
    """Candidate paper ids that also satisfy the structured filters."""
    from app.queries import paper_filter_clauses

    if not cand.relevance:
        return []
    where, params = paper_filter_clauses(
        year_from=year_from, year_to=year_to, venue_id=venue_id,
        author_id=author_id, institution_id=institution_id,
    )
    where = ["p.Paper_ID = ANY(:ids)", *where]
    params["ids"] = list(cand.relevance)
    rows = conn.execute(text(f"SELECT p.Paper_ID FROM PAPER p WHERE {' AND '.join(where)}"), params)
    return [r[0] for r in rows]


def overview(
    conn: Connection,
    q: str,
    *,
    year_from: int | None = None,
    year_to: int | None = None,
    venue_id: int | None = None,
    author_id: int | None = None,
    institution_id: int | None = None,
) -> dict:
    cand = collect_candidates(conn, q)
    common = dict(venue_id=venue_id, author_id=author_id, institution_id=institution_id)
    ids = filtered_ids(conn, cand, year_from=year_from, year_to=year_to, **common)
    ids_all_years = filtered_ids(conn, cand, **common) if (year_from or year_to) else ids

    empty = {
        "query": q,
        "summary": {"papers": 0, "authors": 0, "institutions": 0, "citation_edges": 0,
                    "year_min": None, "year_max": None},
        "year_histogram": [], "top_authors": [], "top_institutions": [], "top_venues": [],
        "topics": [], "keywords": [],
        "meta": {"mongo": cand.mongo, "matched_via": cand.matched_via, "truncated": cand.truncated},
    }

    histogram = fetch_all(
        conn,
        "SELECT Publication_Year AS year, COUNT(*) AS paper_count FROM PAPER "
        "WHERE Paper_ID = ANY(:ids) GROUP BY Publication_Year ORDER BY Publication_Year",
        {"ids": ids_all_years},
    ) if ids_all_years else []
    empty["year_histogram"] = histogram
    if not ids:
        return empty

    p = {"ids": ids}
    row = conn.execute(
        text(
            "SELECT (SELECT COUNT(DISTINCT Author_ID) FROM AUTHORSHIP WHERE Paper_ID = ANY(:ids)), "
            "       (SELECT COUNT(DISTINCT Institution_ID) FROM v_paper_institution WHERE Paper_ID = ANY(:ids)), "
            "       (SELECT COUNT(*) FROM CITATION WHERE Citing_Paper_ID = ANY(:ids) AND Cited_Paper_ID = ANY(:ids)), "
            "       (SELECT MIN(Publication_Year) FROM PAPER WHERE Paper_ID = ANY(:ids)), "
            "       (SELECT MAX(Publication_Year) FROM PAPER WHERE Paper_ID = ANY(:ids))"
        ),
        p,
    ).one()

    top_authors = fetch_all(
        conn,
        """
        SELECT a.Author_ID AS author_id, a.Full_Name AS full_name,
               COUNT(*) AS paper_count, COALESCE(SUM(pp.Citation_Count), 0) AS total_citations
        FROM AUTHORSHIP s
        JOIN AUTHOR a ON a.Author_ID = s.Author_ID
        JOIN PAPER pp ON pp.Paper_ID = s.Paper_ID
        WHERE s.Paper_ID = ANY(:ids)
        GROUP BY a.Author_ID, a.Full_Name
        ORDER BY paper_count DESC, total_citations DESC, a.Full_Name LIMIT 8
        """,
        p,
    )
    top_institutions = fetch_all(
        conn,
        """
        SELECT i.Institution_ID AS institution_id, i.Institution_Name AS name, i.Country AS country,
               COUNT(DISTINCT vi.Paper_ID) AS paper_count
        FROM v_paper_institution vi JOIN INSTITUTION i ON i.Institution_ID = vi.Institution_ID
        WHERE vi.Paper_ID = ANY(:ids)
        GROUP BY i.Institution_ID, i.Institution_Name, i.Country
        ORDER BY paper_count DESC, i.Institution_Name LIMIT 8
        """,
        p,
    )
    top_venues = fetch_all(
        conn,
        """
        SELECT v.Venue_ID AS venue_id, v.Venue_Name AS venue_name, COUNT(*) AS paper_count
        FROM PAPER pp JOIN VENUE v ON v.Venue_ID = pp.Venue_ID
        WHERE pp.Paper_ID = ANY(:ids)
        GROUP BY v.Venue_ID, v.Venue_Name
        ORDER BY paper_count DESC, v.Venue_Name LIMIT 8
        """,
        p,
    )
    topics = fetch_all(
        conn,
        """
        SELECT t.Topic_ID AS topic_id, t.Topic_Name AS topic_name, COUNT(*) AS paper_count,
               ROUND(AVG(pt.Relevance_Score)::numeric, 3)::float8 AS avg_relevance
        FROM PAPER_TOPIC pt JOIN TOPIC t ON t.Topic_ID = pt.Topic_ID
        WHERE pt.Paper_ID = ANY(:ids)
        GROUP BY t.Topic_ID, t.Topic_Name
        ORDER BY paper_count DESC, avg_relevance DESC LIMIT 10
        """,
        p,
    )

    keywords: list[dict] = []
    if cand.mongo != "unavailable":
        try:
            keywords = mongo_store.keyword_counts(ids, exclude=set(mongo_store.query_tokens(q)) | {q.lower()})
        except Exception:                # noqa: BLE001
            log.warning("Mongo keyword aggregation failed", exc_info=True)
            cand.mongo = "unavailable"

    return {
        "query": q,
        "summary": {"papers": len(ids), "authors": row[0], "institutions": row[1],
                    "citation_edges": row[2], "year_min": row[3], "year_max": row[4]},
        "year_histogram": histogram,
        "top_authors": top_authors, "top_institutions": top_institutions, "top_venues": top_venues,
        "topics": topics, "keywords": keywords,
        "meta": {"mongo": cand.mongo, "matched_via": cand.matched_via, "truncated": cand.truncated},
    }


def citation_network(
    conn: Connection,
    q: str,
    *,
    year_from: int | None = None,
    year_to: int | None = None,
    venue_id: int | None = None,
    author_id: int | None = None,
    institution_id: int | None = None,
    max_nodes: int = 400,
) -> dict:
    """G2: the citation network among the current search result set
    (design-system.md §6, Phase 7).

    Same candidate generation and filters as /search/papers, so this is
    always the citation graph of exactly what the result list shows -- never
    a separately-fetched neighborhood. Only edges with both endpoints inside
    the filtered result set are drawn (a "citation network of this search",
    not the whole corpus); a result-set paper that cites or is cited only by
    papers outside the set has nothing to draw and is left out, the same
    isolated-node convention as the G1 community graph. `total_candidates`
    counts those connected papers before the `max_nodes` cap, ranked by
    in-set citation degree (citing + cited, highest first) so the cap keeps
    the most connected part of the graph.

    `community_id` is the paper's authors' majority community (ties broken
    by lowest Community_ID) -- there is no per-paper community, only
    per-author -- and is None for every paper until graph.communities has
    run, the same "not computed" convention as elsewhere in F2.
    """
    cand = collect_candidates(conn, q)
    meta = {"mongo": cand.mongo, "matched_via": cand.matched_via, "truncated": cand.truncated}
    ids = filtered_ids(
        conn, cand, year_from=year_from, year_to=year_to,
        venue_id=venue_id, author_id=author_id, institution_id=institution_id,
    )
    empty = {"nodes": [], "edges": [], "total_candidates": 0, "truncated": False, "query": q, "search_meta": meta}
    if not ids:
        return empty

    edge_rows = fetch_all(
        conn,
        "SELECT Citing_Paper_ID AS citing_id, Cited_Paper_ID AS cited_id FROM CITATION "
        "WHERE Citing_Paper_ID = ANY(:ids) AND Cited_Paper_ID = ANY(:ids)",
        {"ids": ids},
    )
    if not edge_rows:
        return empty

    degree: dict[int, int] = {}
    for e in edge_rows:
        degree[e["citing_id"]] = degree.get(e["citing_id"], 0) + 1
        degree[e["cited_id"]] = degree.get(e["cited_id"], 0) + 1

    total_candidates = len(degree)
    ranked = sorted(degree, key=lambda pid: degree[pid], reverse=True)
    kept_ids = ranked[:max_nodes]
    truncated = total_candidates > len(kept_ids)
    kept = set(kept_ids)

    edges = [
        {"citing_id": e["citing_id"], "cited_id": e["cited_id"]}
        for e in edge_rows
        if e["citing_id"] in kept and e["cited_id"] in kept
    ]

    node_rows = fetch_all(
        conn,
        """
        SELECT p.Paper_ID AS paper_id, p.Title AS title, p.Publication_Year AS year,
               p.Citation_Count AS citation_count, cm.Community_ID AS community_id
        FROM PAPER p
        LEFT JOIN LATERAL (
            SELECT c.Community_ID
            FROM AUTHORSHIP au JOIN COMMUNITY_MEMBER c ON c.Author_ID = au.Author_ID
            WHERE au.Paper_ID = p.Paper_ID
            GROUP BY c.Community_ID
            ORDER BY COUNT(*) DESC, c.Community_ID
            LIMIT 1
        ) cm ON TRUE
        WHERE p.Paper_ID = ANY(:ids)
        """,
        {"ids": kept_ids},
    )

    return {
        "nodes": node_rows,
        "edges": edges,
        "total_candidates": total_candidates,
        "truncated": truncated,
        "query": q,
        "search_meta": meta,
    }
