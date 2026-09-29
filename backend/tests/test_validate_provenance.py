"""
Tests for M3 Part 3 - provenance / merge validation.

Two kinds of test:
  1. The synthetic corpus (cross-source duplicates, DOI-case differences,
     ORCID-URL-vs-bare, name variants, two same-name people) must come out of
     the REAL loader with no `fail`, and every check must actually have run
     (a `skipped` check is a failure here on purpose).
  2. Mutation tests: inject one specific corruption inside a transaction that
     is always rolled back, and assert the matching check turns red. Where the
     database itself forbids the corruption (UNIQUE / CHECK constraints) the
     constraint is dropped INSIDE the rolled-back transaction, so the check's
     own logic is still proven and the schema is never touched.
"""
from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.conftest import q

EXPECTED_CHECKS = (
    "paper_source_coverage", "paper_source_unique", "paper_source_id_columns",
    "doi_lowercase", "doi_unique", "orcid_format", "orcid_unique",
    "author_source_ids_unique", "author_cross_source_evidence",
    "citation_integrity", "citation_count_nonnegative", "citation_count_provenance",
    "resolution_queue_pending",
)


def _status(report: dict) -> dict[str, str]:
    return {c["name"]: c["status"] for c in report["checks"]}


def _validate(conn=None, persist=False):
    from ingestion.validate_provenance import run_validation

    return run_validation(conn=conn, persist=persist)


class _Mutation:
    """Rolled-back transaction: mutate on `conn`, validate on `conn`, undo it all."""

    def __init__(self, engine):
        self.engine = engine

    def __enter__(self):
        self.conn = self.engine.connect()
        self.trans = self.conn.begin()
        return self.conn

    def __exit__(self, *exc):
        self.trans.rollback()
        self.conn.close()


def _drop_constraints(conn, table: str, kinds=("u", "c")):
    names = conn.execute(
        text("SELECT conname FROM pg_constraint WHERE conrelid = CAST(:t AS regclass) AND contype::text = ANY(:k)"),
        {"t": table, "k": list(kinds)},
    ).scalars().all()
    for n in names:
        conn.execute(text(f'ALTER TABLE {table} DROP CONSTRAINT "{n}"'))


# ---------------------------------------------------------------- clean corpus

def test_seeded_corpus_has_no_failed_checks(engine, seeded):
    report = _validate()
    failed = [c for c in report["checks"] if c["status"] == "fail"]
    assert not failed, failed
    assert report["ok"] is True


def test_every_expected_check_ran_and_none_were_skipped(engine, seeded):
    status = _status(_validate())
    missing = [n for n in EXPECTED_CHECKS if n not in status]
    skipped = [n for n in EXPECTED_CHECKS if status.get(n) == "skipped"]
    assert not missing, f"checks not reported: {missing}"
    assert not skipped, f"validator could not evaluate {skipped}: schema names differ from what it discovers"


def test_corpus_really_is_multi_source(engine, seeded):
    stats = _validate()["stats"]
    assert set(stats["papers_by_source"]) >= {"openalex", "semantic_scholar"}
    assert stats["papers_in_multiple_sources"] > 0, "seed_dev marks ~40% of papers as present in both sources"
    assert stats["papers"] < sum(stats["papers_by_source"].values())
    assert stats["authors_in_multiple_sources"] > 0, "authors should be merged across sources through shared papers"


def test_merged_papers_carry_every_source_id(engine, seeded):
    rows = q(engine, "SELECT Paper_ID FROM PAPER WHERE Openalex_Paper_ID IS NOT NULL "
                     "AND Semantic_Scholar_Paper_ID IS NOT NULL")
    assert rows, "expected merged papers holding both an OpenAlex and a Semantic Scholar id (M1 fix #4)"


def test_two_same_name_authors_were_not_merged(engine, seeded):
    assert len(q(engine, "SELECT Author_ID FROM AUTHOR WHERE Full_Name = 'Wei Zhang'")) >= 2


def test_report_is_persisted_to_mongo(engine, seeded, mongo):
    report = _validate(persist=True)
    doc = mongo["graph_snapshot"].find_one({"_id": "provenance"})
    assert doc is not None
    assert doc["ok"] == report["ok"] and doc["counts"] == report["counts"]


def test_validation_is_read_only_and_repeatable(engine, seeded):
    sql = "SELECT (SELECT COUNT(*) FROM PAPER), (SELECT COUNT(*) FROM AUTHOR), (SELECT COUNT(*) FROM CITATION)"
    before = q(engine, sql)
    a, b = _validate(), _validate()
    assert before == q(engine, sql)
    assert _status(a) == _status(b)


# ------------------------------------------------------------------ mutations

def test_detects_paper_without_a_source(engine, seeded):
    (pid,) = q(engine, "SELECT MIN(Paper_ID) FROM PAPER")[0]
    with _Mutation(engine) as conn:
        conn.execute(text("DELETE FROM PAPER_SOURCE WHERE Paper_ID = :p"), {"p": pid})
        assert _status(_validate(conn))["paper_source_coverage"] == "fail"


def test_detects_duplicate_doi_differing_only_in_case(engine, seeded):
    ids = [r[0] for r in q(engine, "SELECT Paper_ID FROM PAPER WHERE DOI IS NOT NULL ORDER BY Paper_ID LIMIT 2")]
    assert len(ids) == 2
    with _Mutation(engine) as conn:
        conn.execute(text("UPDATE PAPER SET DOI = UPPER((SELECT DOI FROM PAPER WHERE Paper_ID = :a)) "
                          "WHERE Paper_ID = :b"), {"a": ids[0], "b": ids[1]})
        status = _status(_validate(conn))
        assert status["doi_unique"] == "fail"
        assert status["doi_lowercase"] == "fail"


def test_detects_source_record_mapped_to_two_papers(engine, seeded):
    (pid, rec) = q(engine, "SELECT Paper_ID, Source_Record_ID FROM PAPER_SOURCE "
                           "WHERE Source_Name = 'semantic_scholar' ORDER BY Paper_ID LIMIT 1")[0]
    (other,) = q(engine, "SELECT Paper_ID FROM PAPER WHERE Paper_ID NOT IN "
                         "(SELECT Paper_ID FROM PAPER_SOURCE WHERE Source_Name = 'semantic_scholar') LIMIT 1")[0]
    with _Mutation(engine) as conn:
        conn.execute(text("INSERT INTO PAPER_SOURCE (Paper_ID, Source_Name, Source_Record_ID) "
                          "VALUES (:p, 'semantic_scholar', :r)"), {"p": other, "r": rec})
        assert _status(_validate(conn))["paper_source_unique"] == "fail"


def test_detects_paper_id_column_disagreeing_with_provenance(engine, seeded):
    (pid,) = q(engine, "SELECT MIN(Paper_ID) FROM PAPER WHERE Openalex_Paper_ID IS NOT NULL")[0]
    with _Mutation(engine) as conn:
        conn.execute(text("UPDATE PAPER SET Openalex_Paper_ID = 'W-WRONG' WHERE Paper_ID = :p"), {"p": pid})
        assert _status(_validate(conn))["paper_source_id_columns"] == "fail"


def test_detects_source_id_never_recorded_on_the_merged_paper(engine, seeded):
    """M1 fix #4 regression: PAPER_SOURCE knows the id, the PAPER column is NULL."""
    (pid,) = q(engine, "SELECT MIN(Paper_ID) FROM PAPER WHERE Semantic_Scholar_Paper_ID IS NOT NULL")[0]
    with _Mutation(engine) as conn:
        conn.execute(text("UPDATE PAPER SET Semantic_Scholar_Paper_ID = NULL WHERE Paper_ID = :p"), {"p": pid})
        assert _status(_validate(conn))["paper_source_id_columns"] == "fail"


def test_detects_orcid_stored_as_url(engine, seeded):
    with _Mutation(engine) as conn:
        conn.execute(text("UPDATE AUTHOR SET ORCID = 'orcid.org/not-bare' "
                          "WHERE Author_ID = (SELECT MIN(Author_ID) FROM AUTHOR)"))
        assert _status(_validate(conn))["orcid_format"] == "fail"


def test_detects_one_orcid_on_two_authors(engine, seeded):
    ids = [r[0] for r in q(engine, "SELECT Author_ID FROM AUTHOR ORDER BY Author_ID LIMIT 2")]
    with _Mutation(engine) as conn:
        _drop_constraints(conn, "author", ("u",))
        conn.execute(text("UPDATE AUTHOR SET ORCID = '0000-0002-1825-0097' "
                          "WHERE Author_ID = :a OR Author_ID = :b"), {"a": ids[0], "b": ids[1]})
        assert _status(_validate(conn))["orcid_unique"] == "fail"


def test_detects_one_source_author_id_on_two_authors(engine, seeded):
    ids = [r[0] for r in q(engine, "SELECT Author_ID FROM AUTHOR ORDER BY Author_ID LIMIT 2")]
    with _Mutation(engine) as conn:
        _drop_constraints(conn, "author", ("u",))
        conn.execute(text("UPDATE AUTHOR SET Openalex_Author_ID = 'A-SAME' WHERE Author_ID = :a OR Author_ID = :b"),
                     {"a": ids[0], "b": ids[1]})
        assert _status(_validate(conn))["author_source_ids_unique"] == "fail"


def test_detects_cross_source_author_merge_without_evidence(engine, seeded):
    """Two authors carry both source ids but no ORCID and no shared multi-source paper."""
    with _Mutation(engine) as conn:
        conn.execute(text("DELETE FROM PAPER_SOURCE WHERE Source_Name = 'semantic_scholar'"))
        conn.execute(text("UPDATE AUTHOR SET ORCID = NULL"))
        report = _validate(conn)
        assert _status(report)["author_cross_source_evidence"] == "fail"


def test_orcid_alone_is_accepted_as_cross_source_evidence(engine, seeded):
    """Remove every shared-paper justification; authors with an ORCID must still pass."""
    with _Mutation(engine) as conn:
        conn.execute(text("DELETE FROM PAPER_SOURCE WHERE Source_Name = 'semantic_scholar'"))
        conn.execute(text("UPDATE AUTHOR SET Semantic_Scholar_Author_ID = NULL WHERE ORCID IS NULL"))
        assert _status(_validate(conn))["author_cross_source_evidence"] == "pass"


def test_detects_self_citation(engine, seeded):
    (pid,) = q(engine, "SELECT MIN(Paper_ID) FROM PAPER")[0]
    with _Mutation(engine) as conn:
        _drop_constraints(conn, "citation", ("c",))
        conn.execute(text("INSERT INTO CITATION (Citing_Paper_ID, Cited_Paper_ID) VALUES (:p, :p)"), {"p": pid})
        assert _status(_validate(conn))["citation_integrity"] == "fail"


def test_detects_untraceable_citation_count(engine, seeded):
    (pid,) = q(engine, "SELECT MIN(Paper_ID) FROM PAPER_SOURCE WHERE Source_Citation_Count IS NOT NULL")[0]
    with _Mutation(engine) as conn:
        conn.execute(text("UPDATE PAPER SET Citation_Count = 987654 WHERE Paper_ID = :p"), {"p": pid})
        assert _status(_validate(conn))["citation_count_provenance"] == "fail"


def test_warns_when_count_ignores_the_preferred_source(engine, seeded):
    rows = q(engine, "SELECT o.Paper_ID, o.Source_Citation_Count FROM PAPER_SOURCE o "
                     "JOIN PAPER_SOURCE s ON s.Paper_ID = o.Paper_ID AND s.Source_Name = 'semantic_scholar' "
                     "WHERE o.Source_Name = 'openalex' AND o.Source_Citation_Count IS NOT NULL "
                     "AND s.Source_Citation_Count IS NOT NULL AND o.Source_Citation_Count <> s.Source_Citation_Count "
                     "LIMIT 1")
    if not rows:
        pytest.skip("no paper whose two sources disagree on the citation count")
    (pid, oa_count) = rows[0]
    with _Mutation(engine) as conn:
        conn.execute(text("UPDATE PAPER SET Citation_Count = :c WHERE Paper_ID = :p"), {"c": oa_count, "p": pid})
        assert _status(_validate(conn))["citation_count_provenance"] == "warn"


def test_detects_negative_citation_count(engine, seeded):
    with _Mutation(engine) as conn:
        conn.execute(text("UPDATE PAPER SET Citation_Count = -3 WHERE Paper_ID = (SELECT MIN(Paper_ID) FROM PAPER)"))
        assert _status(_validate(conn))["citation_count_nonnegative"] == "fail"


def test_warning_examples_from_raw_sql_rows_can_be_persisted(engine, seeded):
    """A warning whose examples come straight from SQL rows (SQLAlchemy 2.x Row,
    not a tuple) must still BSON-encode, or the Mongo report write fails and
    /meta/runs keeps showing a stale report. Found on a 3000-paper seed."""
    import bson

    pid, a, b = q(engine, "SELECT Paper_ID, MIN(Author_ID), MAX(Author_ID) FROM AUTHORSHIP "
                          "GROUP BY Paper_ID HAVING COUNT(*) >= 2 ORDER BY Paper_ID LIMIT 1")[0]
    with _Mutation(engine) as conn:
        conn.execute(text("UPDATE AUTHOR SET Full_Name = (SELECT Full_Name FROM AUTHOR WHERE Author_ID = :a) "
                          "WHERE Author_ID = :b"), {"a": a, "b": b})
        report = _validate(conn)
        assert _status(report)["same_name_coauthors"] == "warn"
        bson.encode({"checks": report["checks"]})  # raises InvalidDocument on a Row
        same = next(c for c in report["checks"] if c["name"] == "same_name_coauthors")
        assert any(ex[0] == pid for ex in same["examples"])


def test_seed_corpus_never_has_a_negative_citation_count():
    """Semantic Scholar's synthetic count is the OpenAlex one plus noise in
    [-2, 6]; a paper with 1 citation could go to -1, which only shows up at
    a few thousand papers."""
    from ingestion.seed_dev import build_dataset

    assert min((p.citation_count or 0) for p in build_dataset(3000)) >= 0


def test_pending_review_queue_is_reported(engine, seeded):
    with _Mutation(engine) as conn:
        conn.execute(text("INSERT INTO ENTITY_RESOLUTION_QUEUE (Entity_Type, Candidate_A, Candidate_B, Match_Confidence) "
                          "VALUES ('paper', '{}'::jsonb, '{}'::jsonb, 0.9)"))
        assert _status(_validate(conn))["resolution_queue_pending"] == "warn"


# ------------------------------------------------------------- Part 3 fixes

def test_stale_tfidf_topics_are_removed_on_rerun(engine, seeded):
    """extract_topics used to leave a paper's old tfidf rows behind on re-run."""
    from ingestion.extract_topics import extract_topics

    extract_topics()
    (pid,) = q(engine, "SELECT MIN(Paper_ID) FROM PAPER")[0]
    with engine.begin() as conn:
        tid = conn.execute(text("INSERT INTO TOPIC (Topic_Name) VALUES ('zz stale test topic') "
                                "ON CONFLICT (Topic_Name) DO UPDATE SET Topic_Name = EXCLUDED.Topic_Name "
                                "RETURNING Topic_ID")).scalar_one()
        conn.execute(text("INSERT INTO PAPER_TOPIC (Paper_ID, Topic_ID, Relevance_Score, Extraction_Method) "
                          "VALUES (:p, :t, 0.5, 'tfidf')"), {"p": pid, "t": tid})
    try:
        extract_topics()
        assert q(engine, "SELECT COUNT(*) FROM PAPER_TOPIC WHERE Topic_ID = :t", t=tid)[0][0] == 0
    finally:
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM PAPER_TOPIC WHERE Topic_ID = :t"), {"t": tid})
            conn.execute(text("DELETE FROM TOPIC WHERE Topic_ID = :t"), {"t": tid})
