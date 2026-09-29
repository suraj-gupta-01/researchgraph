from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.engine import Connection

from app import search as search_service
from app.db import get_conn
from app.queries import CANDIDATE_RELEVANCE_SORT, PAPER_SORTS, paper_filter_clauses, paper_page
from app.schemas import CitationNetwork, Page, PaperSummary, SearchOverview
from app.sqlutil import PageParams, page, page_params

router = APIRouter(prefix="/search", tags=["search (F1)"])

Q = Annotated[str, Query(min_length=1, max_length=200, description="Free-text research topic")]
Year = Annotated[int | None, Query(ge=1800, le=2200)]
Id = Annotated[int | None, Query(ge=1)]


@router.get("/overview", response_model=SearchOverview)
def search_overview(
    conn: Annotated[Connection, Depends(get_conn)],
    q: Q,
    year_from: Year = None,
    year_to: Year = None,
    author_id: Id = None,
    institution_id: Id = None,
    venue_id: Id = None,
):
    """Aggregates for a topic search: counts, year histogram, top authors,
    institutions, venues, topics and related keywords."""
    return search_service.overview(
        conn, q.strip(), year_from=year_from, year_to=year_to,
        author_id=author_id, institution_id=institution_id, venue_id=venue_id,
    )


@router.get("/papers", response_model=Page[PaperSummary])
def search_papers(
    conn: Annotated[Connection, Depends(get_conn)],
    p: Annotated[PageParams, Depends(page_params)],
    q: Q,
    sort: Literal["relevance", "citations", "year", "title"] = "relevance",
    year_from: Year = None,
    year_to: Year = None,
    author_id: Id = None,
    institution_id: Id = None,
    venue_id: Id = None,
):
    """Ranked, paginated papers for a topic search. relevance = 3*title hit +
    2*topic hit + 1*abstract/keyword hit, ties broken by citation count."""
    cand = search_service.collect_candidates(conn, q.strip())
    ids = list(cand.relevance)
    rels = [cand.relevance[i] for i in ids]
    where, params = paper_filter_clauses(
        year_from=year_from, year_to=year_to, venue_id=venue_id,
        author_id=author_id, institution_id=institution_id,
    )
    sort_sql = CANDIDATE_RELEVANCE_SORT if sort == "relevance" else PAPER_SORTS[sort]
    items, total = paper_page(conn, where=where, params=params, sort_sql=sort_sql, page=p, candidates=(ids, rels))
    return page(items, total, p)


@router.get("/citation-network", response_model=CitationNetwork)
def search_citation_network(
    conn: Annotated[Connection, Depends(get_conn)],
    q: Q,
    year_from: Year = None,
    year_to: Year = None,
    author_id: Id = None,
    institution_id: Id = None,
    venue_id: Id = None,
    max_nodes: Annotated[
        int, Query(ge=1, le=2000, description="Cap on nodes, kept by in-set citation degree")
    ] = 400,
):
    """G2 (Phase 7 frontend): the citation network of the current search
    result set -- directed citing -> cited edges among the same papers
    /search/papers would list, filtered the same way. A paper with no
    citation link to another paper in the set is left out (nothing to draw);
    see search.citation_network for the full rationale."""
    return search_service.citation_network(
        conn, q.strip(), year_from=year_from, year_to=year_to,
        author_id=author_id, institution_id=institution_id, venue_id=venue_id,
        max_nodes=max_nodes,
    )
