"""Shared paper-list query used by /papers, /papers/{id}/citations and /search/papers."""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.sqlutil import PageParams

_PAPER_COLS = """
    p.Paper_ID AS paper_id, p.Title AS title, p.DOI AS doi,
    p.Publication_Year AS publication_year, p.Citation_Count AS citation_count,
    p.Venue_ID AS venue_id, v.Venue_Name AS venue_name,
    au.authors AS authors, COALESCE(au.author_count, 0) AS author_count
"""

_PAPER_JOINS = """
    LEFT JOIN VENUE v ON v.Venue_ID = p.Venue_ID
    LEFT JOIN LATERAL (
        SELECT COALESCE(json_agg(x.Full_Name ORDER BY x.rn) FILTER (WHERE x.rn <= 4), '[]'::json) AS authors,
               MAX(x.n) AS author_count
        FROM (
            SELECT a.Full_Name,
                   ROW_NUMBER() OVER (ORDER BY s.Author_Position NULLS LAST, a.Author_ID) AS rn,
                   COUNT(*) OVER () AS n
            FROM AUTHORSHIP s JOIN AUTHOR a ON a.Author_ID = s.Author_ID
            WHERE s.Paper_ID = p.Paper_ID
        ) x
    ) au ON TRUE
"""

# Whitelisted ORDER BY fragments; the request only ever selects a key.
# Every order ends in Paper_ID so pagination is stable.
PAPER_SORTS = {
    "citations": "p.Citation_Count DESC, p.Publication_Year DESC, p.Paper_ID",
    "year": "p.Publication_Year DESC, p.Citation_Count DESC, p.Paper_ID",
    "title": "p.Title ASC, p.Paper_ID",
}
CANDIDATE_RELEVANCE_SORT = "m.relevance DESC, p.Citation_Count DESC, p.Paper_ID"
TITLE_RELEVANCE_SORT = (
    "ts_rank(p.Title_TSV, websearch_to_tsquery('english', :q)) DESC, p.Citation_Count DESC, p.Paper_ID"
)


def paper_filter_clauses(
    *,
    year_from: int | None = None,
    year_to: int | None = None,
    venue_id: int | None = None,
    author_id: int | None = None,
    institution_id: int | None = None,
    topic_id: int | None = None,
) -> tuple[list[str], dict]:
    """Returns (WHERE fragments, bind params). Fragments are constants."""
    where: list[str] = []
    params: dict = {}
    if year_from is not None:
        where.append("p.Publication_Year >= :year_from")
        params["year_from"] = year_from
    if year_to is not None:
        where.append("p.Publication_Year <= :year_to")
        params["year_to"] = year_to
    if venue_id is not None:
        where.append("p.Venue_ID = :venue_id")
        params["venue_id"] = venue_id
    if author_id is not None:
        where.append("EXISTS (SELECT 1 FROM AUTHORSHIP fa WHERE fa.Paper_ID = p.Paper_ID AND fa.Author_ID = :author_id)")
        params["author_id"] = author_id
    if institution_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM v_paper_institution fi "
            "WHERE fi.Paper_ID = p.Paper_ID AND fi.Institution_ID = :institution_id)"
        )
        params["institution_id"] = institution_id
    if topic_id is not None:
        # The topic and all of its descendants (self-referencing TOPIC hierarchy).
        where.append(
            "EXISTS (SELECT 1 FROM PAPER_TOPIC ft WHERE ft.Paper_ID = p.Paper_ID AND ft.Topic_ID IN ("
            "WITH RECURSIVE d(id) AS (SELECT Topic_ID FROM TOPIC WHERE Topic_ID = :topic_id "
            "UNION SELECT t.Topic_ID FROM TOPIC t JOIN d ON t.Parent_Topic_ID = d.id) SELECT id FROM d))"
        )
        params["topic_id"] = topic_id
    return where, params


def paper_page(
    conn: Connection,
    *,
    where: list[str],
    params: dict,
    sort_sql: str,
    page: PageParams,
    candidates: tuple[list[int], list[float]] | None = None,
) -> tuple[list[dict], int]:
    """Run one page of the paper list. `where` / `sort_sql` must be constants
    from this module; all request values travel in `params`.

    `candidates` = (paper_ids, relevance scores) restricts the list to a
    search result set and exposes m.relevance.
    """
    params = dict(params)
    frm = "PAPER p"
    rel_col = ""
    if candidates is not None:
        ids, rels = candidates
        if not ids:
            return [], 0
        frm = (
            "PAPER p JOIN unnest(CAST(:cand_ids AS int[]), CAST(:cand_rel AS float8[])) "
            "AS m(paper_id, relevance) ON m.paper_id = p.Paper_ID"
        )
        rel_col = ", m.relevance AS relevance"
        params["cand_ids"] = ids
        params["cand_rel"] = rels
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    total = conn.execute(text(f"SELECT COUNT(*) FROM {frm} {where_sql}"), params).scalar_one()
    rows = conn.execute(
        text(
            f"SELECT {_PAPER_COLS}{rel_col} FROM {frm} {_PAPER_JOINS} {where_sql} "
            f"ORDER BY {sort_sql} LIMIT :limit OFFSET :offset"
        ),
        {**params, "limit": page.limit, "offset": page.offset},
    ).mappings().all()
    return [dict(r) for r in rows], total
