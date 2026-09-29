from __future__ import annotations

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app import mongo_store
from app.db import get_conn
from app.queries import PAPER_SORTS, TITLE_RELEVANCE_SORT, paper_filter_clauses, paper_page
from app.schemas import ChainNode, Page, PaperDetail, PaperSummary
from app.sqlutil import PageParams, fetch_all, fetch_one, page, page_params

log = logging.getLogger("researchgraph.papers")
router = APIRouter(prefix="/papers", tags=["papers"])

Year = Annotated[int | None, Query(ge=1800, le=2200)]
Id = Annotated[int | None, Query(ge=1)]


@router.get("", response_model=Page[PaperSummary])
def list_papers(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    q: Annotated[str | None, Query(min_length=1, max_length=200, description="Title search")] = None,
    sort: Literal["citations", "year", "title", "relevance"] = "citations",
    year_from: Year = None,
    year_to: Year = None,
    venue_id: Id = None,
    author_id: Id = None,
    institution_id: Id = None,
    topic_id: Id = None,
):
    """Browse/filter papers. `q` is a title full-text query (websearch syntax:
    quotes, OR, -exclude). `topic_id` includes the topic's descendants.
    For topic exploration across abstracts use /search/*."""
    where, params = paper_filter_clauses(
        year_from=year_from, year_to=year_to, venue_id=venue_id,
        author_id=author_id, institution_id=institution_id, topic_id=topic_id,
    )
    if q:
        where.append("p.Title_TSV @@ websearch_to_tsquery('english', :q)")
        params["q"] = q.strip()
    if sort == "relevance":
        if not q:
            raise HTTPException(422, "sort=relevance needs q; use /search/papers for topic relevance")
        sort_sql = TITLE_RELEVANCE_SORT
    else:
        sort_sql = PAPER_SORTS[sort]
    items, total = paper_page(conn, where=where, params=params, sort_sql=sort_sql, page=p)
    return page(items, total, p)


@router.get("/{paper_id}", response_model=PaperDetail)
def paper_detail(paper_id: int, conn: Annotated[Connection, Depends(get_conn)]):
    base = fetch_one(
        conn,
        """
        SELECT p.Paper_ID AS paper_id, p.Title AS title, p.DOI AS doi,
               p.Publication_Year AS publication_year, p.Citation_Count AS citation_count,
               v.Venue_ID AS v_id, v.Venue_Name AS v_name, v.Venue_Type AS v_type, v.Publisher AS v_pub
        FROM PAPER p LEFT JOIN VENUE v ON v.Venue_ID = p.Venue_ID
        WHERE p.Paper_ID = :id
        """,
        {"id": paper_id},
    )
    if base is None:
        raise HTTPException(404, "Paper not found")

    authors = fetch_all(
        conn,
        """
        SELECT a.Author_ID AS author_id, a.Full_Name AS full_name, a.ORCID AS orcid,
               s.Author_Position AS position,
               COALESCE(json_agg(json_build_object(
                   'institution_id', i.Institution_ID, 'name', i.Institution_Name, 'country', i.Country)
                   ORDER BY i.Institution_Name) FILTER (WHERE i.Institution_ID IS NOT NULL), '[]'::json) AS institutions
        FROM AUTHORSHIP s
        JOIN AUTHOR a ON a.Author_ID = s.Author_ID
        LEFT JOIN AUTHOR_INSTITUTION ai ON ai.Author_ID = a.Author_ID AND ai.Start_Year = :year
        LEFT JOIN INSTITUTION i ON i.Institution_ID = ai.Institution_ID
        WHERE s.Paper_ID = :id
        GROUP BY a.Author_ID, a.Full_Name, a.ORCID, s.Author_Position
        ORDER BY s.Author_Position NULLS LAST, a.Author_ID
        """,
        {"id": paper_id, "year": base["publication_year"]},
    )
    sources = fetch_all(
        conn,
        "SELECT Source_Name AS source_name, Source_Record_ID AS source_record_id, "
        "Source_Citation_Count AS source_citation_count, Fetched_At AS fetched_at "
        "FROM PAPER_SOURCE WHERE Paper_ID = :id ORDER BY Source_Name",
        {"id": paper_id},
    )
    topics = fetch_all(
        conn,
        "SELECT t.Topic_ID AS topic_id, t.Topic_Name AS topic_name, pt.Relevance_Score::float8 AS relevance_score, "
        "pt.Extraction_Method AS extraction_method "
        "FROM PAPER_TOPIC pt JOIN TOPIC t ON t.Topic_ID = pt.Topic_ID "
        "WHERE pt.Paper_ID = :id ORDER BY pt.Relevance_Score DESC, t.Topic_Name",
        {"id": paper_id},
    )
    edges = conn.execute(
        text(
            "SELECT (SELECT COUNT(*) FROM CITATION WHERE Citing_Paper_ID = :id), "
            "       (SELECT COUNT(*) FROM CITATION WHERE Cited_Paper_ID = :id)"
        ),
        {"id": paper_id},
    ).one()

    abstract, keywords, status = None, [], "missing"
    try:
        doc = mongo_store.paper_text(paper_id)
        if doc:
            abstract = doc.get("abstract") or None
            keywords = doc.get("keywords") or []
            status = "ok" if abstract else "missing"
    except Exception:                    # noqa: BLE001 - Mongo being down must not break the paper page
        log.warning("Mongo lookup failed for paper %s", paper_id, exc_info=True)
        status = "unavailable"

    venue = (
        {"venue_id": base["v_id"], "venue_name": base["v_name"], "venue_type": base["v_type"], "publisher": base["v_pub"]}
        if base["v_id"] is not None else None
    )
    return {
        **{k: base[k] for k in ("paper_id", "title", "doi", "publication_year", "citation_count")},
        "venue": venue, "authors": authors, "sources": sources, "topics": topics,
        "cites_in_corpus": edges[0], "cited_by_in_corpus": edges[1],
        "abstract": abstract, "keywords": keywords, "text_status": status,
    }


@router.get("/{paper_id}/citations", response_model=Page[PaperSummary])
def paper_citations(
    paper_id: int,
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    direction: Literal["cites", "cited_by"] = "cited_by",
    sort: Literal["citations", "year", "title"] = "citations",
):
    """Direct citation neighbours inside the loaded corpus.
    direction=cites: papers this paper cites. direction=cited_by: papers citing it."""
    if fetch_one(conn, "SELECT 1 AS x FROM PAPER WHERE Paper_ID = :id", {"id": paper_id}) is None:
        raise HTTPException(404, "Paper not found")
    if direction == "cites":
        where = ["EXISTS (SELECT 1 FROM CITATION c WHERE c.Citing_Paper_ID = :pid AND c.Cited_Paper_ID = p.Paper_ID)"]
    else:
        where = ["EXISTS (SELECT 1 FROM CITATION c WHERE c.Cited_Paper_ID = :pid AND c.Citing_Paper_ID = p.Paper_ID)"]
    items, total = paper_page(conn, where=where, params={"pid": paper_id}, sort_sql=PAPER_SORTS[sort], page=p)
    return page(items, total, p)


# Recursive traversal of citation chains (PRD Section 9: A -> B -> C -> D).
# Two fixed statements; the request only picks one, never edits the SQL.
# `path` guards against cycles (bad data can contain them); DISTINCT ON keeps
# each paper at its shallowest depth.
_CHAIN_SQL = """
WITH RECURSIVE chain(paper_id, depth, parent_id, path) AS (
    SELECT c.{next}, 1, c.{cur}, ARRAY[c.{cur}, c.{next}]
    FROM CITATION c WHERE c.{cur} = :pid
  UNION ALL
    SELECT c.{next}, ch.depth + 1, ch.paper_id, ch.path || c.{next}
    FROM chain ch JOIN CITATION c ON c.{cur} = ch.paper_id
    WHERE ch.depth < :max_depth AND NOT (c.{next} = ANY(ch.path))
)
SELECT n.paper_id, p.Title AS title, p.Publication_Year AS publication_year,
       p.Citation_Count AS citation_count, n.depth, n.parent_id AS parent_paper_id
FROM (SELECT DISTINCT ON (paper_id) paper_id, depth, parent_id FROM chain ORDER BY paper_id, depth, parent_id) n
JOIN PAPER p ON p.Paper_ID = n.paper_id
ORDER BY n.depth, p.Citation_Count DESC, n.paper_id
LIMIT :cap
"""
_CHAIN = {
    "cites": _CHAIN_SQL.format(cur="Citing_Paper_ID", next="Cited_Paper_ID"),
    "cited_by": _CHAIN_SQL.format(cur="Cited_Paper_ID", next="Citing_Paper_ID"),
}


@router.get("/{paper_id}/citation-chain", response_model=list[ChainNode])
def citation_chain(
    paper_id: int,
    conn: Annotated[Connection, Depends(get_conn)],
    direction: Literal["cites", "cited_by"] = "cites",
    depth: Annotated[int, Query(ge=1, le=5)] = 3,
):
    """Papers reachable by following citations up to `depth` hops
    (recursive CTE). direction=cites follows references forward in the
    citation graph; cited_by follows citing papers."""
    if fetch_one(conn, "SELECT 1 AS x FROM PAPER WHERE Paper_ID = :id", {"id": paper_id}) is None:
        raise HTTPException(404, "Paper not found")
    return fetch_all(conn, _CHAIN[direction], {"pid": paper_id, "max_depth": depth, "cap": 500})
