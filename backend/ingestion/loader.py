"""
Loads normalized, cross-source-resolved papers into PostgreSQL (structured:
Paper/Author/Institution/Venue/Authorship/AuthorInstitution/
PaperAuthorInstitution/PaperTopic/Citation/PaperSource)
and MongoDB (flexible: abstract, keywords, embedding, raw_response) per the
division of responsibility in PRD Section 6.4.

Conflict rule (Section 6.2): where both sources return a citation count for
the same DOI-matched paper, prefer Semantic Scholar (richer citation
context) and fall back to OpenAlex when DOI is missing or Semantic Scholar
coverage is thin.
"""
from __future__ import annotations

import json
import logging

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.db import get_engine, get_mongo_db
from ingestion.common_schema import NormalizedPaper, normalize_doi
from ingestion.entity_resolution import (
    paper_to_review_dict,
    resolve_author,
    resolve_institution,
    resolve_paper,
)

log = logging.getLogger("researchgraph.loader")


def _get_or_create_venue(conn: Connection, venue) -> int | None:
    if venue is None:
        return None
    row = conn.execute(
        text("SELECT Venue_ID FROM VENUE WHERE Venue_Name = :name AND Venue_Type IS NOT DISTINCT FROM :vtype"),
        {"name": venue.name, "vtype": venue.venue_type},
    ).fetchone()
    if row:
        return row[0]
    result = conn.execute(
        text(
            "INSERT INTO VENUE (Venue_Name, Venue_Type, Publisher, ISSN) "
            "VALUES (:name, :vtype, :publisher, :issn) RETURNING Venue_ID"
        ),
        {"name": venue.name, "vtype": venue.venue_type, "publisher": venue.publisher, "issn": venue.issn},
    )
    return result.scalar_one()


def _get_or_create_institution(conn: Connection, inst) -> int:
    if inst.ror_id:
        row = conn.execute(
            text("SELECT Institution_ID FROM INSTITUTION WHERE ROR_ID = :ror"), {"ror": inst.ror_id}
        ).fetchone()
        if row:
            return row[0]

    row = conn.execute(
        text(
            "SELECT Institution_ID FROM INSTITUTION "
            "WHERE Institution_Name = :name AND Country IS NOT DISTINCT FROM :country"
        ),
        {"name": inst.name, "country": inst.country},
    ).fetchone()
    if row:
        return row[0]

    result = conn.execute(
        text(
            "INSERT INTO INSTITUTION (Institution_Name, Country, ROR_ID) "
            "VALUES (:name, :country, :ror) RETURNING Institution_ID"
        ),
        {"name": inst.name, "country": inst.country, "ror": inst.ror_id},
    )
    return result.scalar_one()


_AUTHOR_ID_COLS = {"openalex": "Openalex_Author_ID", "semantic_scholar": "Semantic_Scholar_Author_ID"}
_PAPER_ID_COLS = {"openalex": "Openalex_Paper_ID", "semantic_scholar": "Semantic_Scholar_Paper_ID"}


def _attach_author_ids(conn: Connection, author_id: int, author) -> None:
    """Record this source's identifiers on an existing AUTHOR row so later
    lookups by source ID / ORCID hit directly. Guarded so a value that already
    belongs to a different row is never stolen (UNIQUE columns)."""
    id_col = _AUTHOR_ID_COLS[author.source_name]
    if author.source_author_id:
        conn.execute(
            text(
                f"UPDATE AUTHOR SET {id_col} = :sid WHERE Author_ID = :aid AND {id_col} IS NULL "
                f"AND NOT EXISTS (SELECT 1 FROM AUTHOR WHERE {id_col} = :sid)"
            ),
            {"sid": author.source_author_id, "aid": author_id},
        )
    if author.orcid:
        conn.execute(
            text(
                "UPDATE AUTHOR SET ORCID = :orcid WHERE Author_ID = :aid AND ORCID IS NULL "
                "AND NOT EXISTS (SELECT 1 FROM AUTHOR WHERE ORCID = :orcid)"
            ),
            {"orcid": author.orcid, "aid": author_id},
        )


def _resolve_author(conn: Connection, author, paper_id: int, claimed: set[int]) -> int:
    """Find or create the AUTHOR row for one incoming authorship.

    Order: ORCID -> this source's own ID -> fuzzy name match *restricted to the
    authors already attached to this same paper* (a paper matched across
    sources by DOI is the strongest available signal that two name variants are
    the same person) -> create new.

    There is deliberately no corpus-wide fuzzy fallback: two different people
    named "Wei Zhang" must not collapse into one node, which would corrupt every
    community/centrality result downstream.
    """
    id_col = _AUTHOR_ID_COLS[author.source_name]

    if author.orcid:
        row = conn.execute(text("SELECT Author_ID FROM AUTHOR WHERE ORCID = :orcid"), {"orcid": author.orcid}).fetchone()
        if row:
            _attach_author_ids(conn, row[0], author)
            return row[0]

    if author.source_author_id:
        row = conn.execute(
            text(f"SELECT Author_ID FROM AUTHOR WHERE {id_col} = :sid"), {"sid": author.source_author_id}
        ).fetchone()
        if row:
            return row[0]

    # Same-paper candidates that this source has not already supplied an ID for.
    peers = conn.execute(
        text(
            f"SELECT a.Author_ID, a.Full_Name FROM AUTHORSHIP s JOIN AUTHOR a ON a.Author_ID = s.Author_ID "
            f"WHERE s.Paper_ID = :pid AND a.{id_col} IS NULL"
        ),
        {"pid": paper_id},
    ).fetchall()
    existing_names = {str(r[0]): r[1] for r in peers if r[0] not in claimed}
    if existing_names:
        match = resolve_author(author, {}, existing_names, shared_paper_hint=True)
        if match.matched_key:
            author_id = int(match.matched_key)
            _attach_author_ids(conn, author_id, author)
            return author_id
        if match.queued and match.candidate_key:
            conn.execute(
                text(
                    "INSERT INTO ENTITY_RESOLUTION_QUEUE (Entity_Type, Candidate_A, Candidate_B, Match_Confidence) "
                    "VALUES ('author', CAST(:a AS jsonb), CAST(:b AS jsonb), :conf)"
                ),
                {
                    "a": json.dumps({"full_name": author.full_name, "source": author.source_name,
                                     "source_author_id": author.source_author_id, "paper_id": paper_id}),
                    "b": json.dumps({"author_id": int(match.candidate_key),
                                     "full_name": existing_names[match.candidate_key]}),
                    "conf": match.confidence,
                },
            )

    result = conn.execute(
        text(f"INSERT INTO AUTHOR (Full_Name, ORCID, {id_col}) VALUES (:name, :orcid, :sid) RETURNING Author_ID"),
        {"name": author.full_name, "orcid": author.orcid, "sid": author.source_author_id or None},
    )
    return result.scalar_one()


def _get_or_create_paper(conn: Connection, paper: NormalizedPaper) -> tuple[int, bool]:
    """Returns (Paper_ID, created). Handles the DOI-first, fuzzy-title-fallback
    merge described in entity_resolution.resolve_paper, then upserts the
    PAPER_SOURCE provenance row."""
    id_col = "Openalex_Paper_ID" if paper.source_name == "openalex" else "Semantic_Scholar_Paper_ID"
    created = False

    row = None
    if paper.doi:
        row = conn.execute(text("SELECT Paper_ID FROM PAPER WHERE DOI = :doi"), {"doi": paper.doi}).fetchone()
    if row is None:
        row = conn.execute(
            text(f"SELECT Paper_ID FROM PAPER WHERE {id_col} = :sid"), {"sid": paper.source_paper_id}
        ).fetchone()

    if row is None:
        existing = conn.execute(text("SELECT Paper_ID, Title, Publication_Year, DOI FROM PAPER")).fetchall()
        existing_by_doi: dict[str, str] = {}
        # Two different DOIs are two different works (e.g. a preprint and its
        # journal version, or generically-titled editorials), so a fuzzy title
        # match is only allowed against papers that do not carry a conflicting DOI.
        existing_titles = {
            str(r[0]): (r[1], r[2])
            for r in existing
            if not (paper.doi and r[3] and r[3] != paper.doi)
        }
        match = resolve_paper(paper, existing_by_doi, existing_titles)

        if match.matched_key:
            row = (int(match.matched_key),)
        elif match.queued:
            conn.execute(
                text(
                    "INSERT INTO ENTITY_RESOLUTION_QUEUE (Entity_Type, Candidate_A, Candidate_B, Match_Confidence) "
                    "VALUES ('paper', CAST(:a AS jsonb), CAST(:b AS jsonb), :conf)"
                ),
                {
                    "a": json.dumps(paper_to_review_dict(paper), default=str),
                    "b": json.dumps(
                        {
                            "paper_id": int(match.candidate_key) if match.candidate_key else None,
                            "title": existing_titles[match.candidate_key][0] if match.candidate_key else None,
                            "note": "best fuzzy title+year match against existing PAPER rows",
                        }
                    ),
                    "conf": match.confidence,
                },
            )

    if row is None:
        venue_id = _get_or_create_venue(conn, paper.venue)
        result = conn.execute(
            text(
                f"INSERT INTO PAPER (Title, DOI, Publication_Year, Venue_ID, Citation_Count, {id_col}) "
                f"VALUES (:title, :doi, :year, :venue_id, :cites, :sid) RETURNING Paper_ID"
            ),
            {
                "title": paper.title,
                "doi": paper.doi,
                "year": paper.publication_year,
                "venue_id": venue_id,
                "cites": paper.citation_count or 0,
                "sid": paper.source_paper_id,
            },
        )
        paper_id = result.scalar_one()
        created = True
    else:
        paper_id = row[0]
        # Record this source's native ID (and a DOI if we lacked one) on the
        # merged row; otherwise the second source's record is invisible to
        # any lookup by source ID (e.g. citation linking).
        conn.execute(
            text(
                f"UPDATE PAPER SET {id_col} = :sid WHERE Paper_ID = :pid AND {id_col} IS NULL "
                f"AND NOT EXISTS (SELECT 1 FROM PAPER WHERE {id_col} = :sid)"
            ),
            {"sid": paper.source_paper_id, "pid": paper_id},
        )
        if paper.doi:
            conn.execute(
                text(
                    "UPDATE PAPER SET DOI = :doi WHERE Paper_ID = :pid AND DOI IS NULL "
                    "AND NOT EXISTS (SELECT 1 FROM PAPER WHERE DOI = :doi)"
                ),
                {"doi": paper.doi, "pid": paper_id},
            )
        # Conflict rule: prefer Semantic Scholar's citation count when both
        # exist; only overwrite with OpenAlex's if we don't have one yet.
        if paper.citation_count is not None:
            if paper.source_name == "semantic_scholar":
                conn.execute(
                    text("UPDATE PAPER SET Citation_Count = :c WHERE Paper_ID = :pid"),
                    {"c": paper.citation_count, "pid": paper_id},
                )
            else:
                conn.execute(
                    text(
                        "UPDATE PAPER SET Citation_Count = :c WHERE Paper_ID = :pid AND Citation_Count = 0"
                    ),
                    {"c": paper.citation_count, "pid": paper_id},
                )

    conn.execute(
        text(
            "INSERT INTO PAPER_SOURCE (Paper_ID, Source_Name, Source_Record_ID, Source_Citation_Count) "
            "VALUES (:pid, :sname, :srid, :scount) "
            "ON CONFLICT (Paper_ID, Source_Name) DO UPDATE "
            "SET Source_Record_ID = EXCLUDED.Source_Record_ID, "
            "    Source_Citation_Count = EXCLUDED.Source_Citation_Count, "
            "    Fetched_At = now()"
        ),
        {
            "pid": paper_id,
            "sname": paper.source_name,
            "srid": paper.source_paper_id,
            "scount": paper.citation_count,
        },
    )

    return paper_id, created


def load_papers(papers: list[NormalizedPaper]) -> dict[str, int]:
    """Loads a batch of normalized papers (from either or both sources).
    Returns counts for a quick ingestion summary."""
    stats = {"papers_created": 0, "papers_matched": 0, "papers_skipped_no_year": 0,
             "authorships": 0, "institutions_linked": 0}
    mongo_docs = []

    with get_engine().begin() as conn:
        for paper in papers:
            if not paper.publication_year:
                # The whole system is temporal (F3/F5); an undated paper cannot be placed.
                stats["papers_skipped_no_year"] += 1
                continue
            paper_id, created = _get_or_create_paper(conn, paper)
            stats["papers_created" if created else "papers_matched"] += 1

            claimed: set[int] = set()
            for position, authorship in enumerate(paper.authorships, start=1):
                author_id = _resolve_author(conn, authorship.author, paper_id, claimed)
                claimed.add(author_id)
                conn.execute(
                    text(
                        "INSERT INTO AUTHORSHIP (Author_ID, Paper_ID, Author_Position) "
                        "VALUES (:aid, :pid, :pos) ON CONFLICT (Author_ID, Paper_ID) DO NOTHING"
                    ),
                    {"aid": author_id, "pid": paper_id, "pos": authorship.position or position},
                )
                stats["authorships"] += 1

                for inst in authorship.institutions:
                    inst_id = _get_or_create_institution(conn, inst)
                    conn.execute(
                        text(
                            "INSERT INTO AUTHOR_INSTITUTION (Author_ID, Institution_ID, Start_Year) "
                            "VALUES (:aid, :iid, :yr) ON CONFLICT (Author_ID, Institution_ID, Start_Year) DO NOTHING"
                        ),
                        {"aid": author_id, "iid": inst_id, "yr": paper.publication_year},
                    )
                    # Per-paper attribution (M4 pre-work): the coarser
                    # AUTHOR_INSTITUTION row above can't tell two affiliations
                    # held in the same year apart; this one records exactly
                    # which institution this authorship on *this* paper
                    # carried, straight from the source authorship record.
                    conn.execute(
                        text(
                            "INSERT INTO PAPER_AUTHOR_INSTITUTION (Paper_ID, Author_ID, Institution_ID) "
                            "VALUES (:pid, :aid, :iid) ON CONFLICT (Paper_ID, Author_ID, Institution_ID) DO NOTHING"
                        ),
                        {"pid": paper_id, "aid": author_id, "iid": inst_id},
                    )
                    stats["institutions_linked"] += 1

            mongo_docs.append(
                {
                    "paper_id": paper_id,
                    "source": paper.source_name,
                    "abstract": paper.abstract,
                    "keywords": paper.keywords,
                    "embedding": paper.embedding,
                    "nlp_status": "pending",   # flipped to 'processed' by the M3 topic-extraction job
                    "raw_response": paper.raw_response,
                }
            )

    if mongo_docs:
        mongo = get_mongo_db()
        for doc in mongo_docs:
            mongo.paper_metadata.update_one(
                {"paper_id": doc["paper_id"], "source": doc["source"]}, {"$set": doc}, upsert=True
            )

    log.info("Load complete: %s", stats)
    return stats


def _resolve_paper_ids(conn: Connection, source_name: str | None, ref: str) -> set[int]:
    """Map a source-native reference (OpenAlex work URL, S2 paperId, or DOI)
    to internal Paper_IDs. Resolves through PAPER_SOURCE (provenance) first so
    a paper ingested from either source is found no matter which one created it."""
    ids: set[int] = set()
    rows = conn.execute(
        text("SELECT Paper_ID FROM PAPER_SOURCE WHERE Source_Record_ID = :ref"), {"ref": ref}
    ).fetchall()
    ids.update(r[0] for r in rows)
    doi = normalize_doi(ref)
    if doi:
        rows = conn.execute(text("SELECT Paper_ID FROM PAPER WHERE DOI = :doi"), {"doi": doi}).fetchall()
        ids.update(r[0] for r in rows)
    return ids


def link_citations(papers: list[NormalizedPaper]) -> int:
    """Second pass: citations reference source-native paper IDs, which only
    resolve to internal Paper_IDs once every paper in the batch has been
    loaded. Run this after load_papers() for the same batch. Edges are
    (citing -> cited); references to papers outside the ingested corpus are
    dropped, so CITATION only ever contains edges between loaded papers."""
    linked = 0
    with get_engine().begin() as conn:
        for paper in papers:
            citing_ids = conn.execute(
                text("SELECT Paper_ID FROM PAPER_SOURCE WHERE Source_Name = :s AND Source_Record_ID = :sid"),
                {"s": paper.source_name, "sid": paper.source_paper_id},
            ).fetchall()
            if not citing_ids:
                continue
            citing_id = citing_ids[0][0]

            cited: set[int] = set()
            for ref in paper.cited_source_paper_ids:
                cited |= _resolve_paper_ids(conn, paper.source_name, ref)
            cited.discard(citing_id)

            for cited_id in cited:
                result = conn.execute(
                    text(
                        "INSERT INTO CITATION (Citing_Paper_ID, Cited_Paper_ID) "
                        "VALUES (:citing, :cited) ON CONFLICT DO NOTHING"
                    ),
                    {"citing": citing_id, "cited": cited_id},
                )
                linked += result.rowcount
    return linked
