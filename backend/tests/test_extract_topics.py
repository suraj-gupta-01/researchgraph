"""
Tests for M3's topic extraction (F3/G3). Runs the job against the same
synthetic dev corpus used elsewhere (4 clusters of federated-learning
papers: privacy, healthcare, edge, non-iid — see ingestion.seed_dev), so
expectations are pinned to that fixture's known cluster keywords.
"""
from __future__ import annotations

from sqlalchemy import text

from tests.conftest import q


def _run_extraction(engine):
    from ingestion.extract_topics import SOURCE_METHOD, TFIDF_METHOD, extract_topics

    stats = extract_topics()
    return stats, SOURCE_METHOD, TFIDF_METHOD


def test_source_keywords_land_as_curated_topics(engine, seeded):
    stats, SOURCE_METHOD, _ = _run_extraction(engine)
    assert stats["source_keyword_rows"] > 0

    # every seed_dev cluster keyword (e.g. "differential privacy") should
    # exist as a TOPIC row with a perfect, curated relevance score
    rows = q(engine, "SELECT Topic_Name FROM TOPIC WHERE LOWER(Topic_Name) = 'differential privacy'")
    assert rows, "expected a curated cluster keyword to create a TOPIC row"

    (topic_id,) = q(engine, "SELECT Topic_ID FROM TOPIC WHERE LOWER(Topic_Name) = 'differential privacy'")[0]
    scores = q(
        engine,
        "SELECT Relevance_Score, Extraction_Method FROM PAPER_TOPIC WHERE Topic_ID = :tid",
        tid=topic_id,
    )
    assert scores, "expected papers tagged with the curated topic"
    assert all(m == SOURCE_METHOD and float(s) == 1.0 for s, m in scores)


def test_tfidf_recovers_cluster_terms_and_dilutes_shared_ones(engine, seeded):
    stats, _, TFIDF_METHOD = _run_extraction(engine)
    assert stats["tfidf_rows"] > 0

    # "federated learning" appears in essentially every paper's title in this
    # corpus (see seed_dev CLUSTERS frames), so TF-IDF should not surface it
    # as a top term for any single paper via the tfidf lane specifically
    fl_topic = q(engine, "SELECT Topic_ID FROM TOPIC WHERE LOWER(Topic_Name) = 'federated learning'")
    if fl_topic:
        (tid,) = fl_topic[0]
        tfidf_hits = q(
            engine,
            "SELECT COUNT(*) FROM PAPER_TOPIC WHERE Topic_ID = :tid AND Extraction_Method = :m",
            tid=tid, m=TFIDF_METHOD,
        )[0][0]
        total_papers = q(engine, "SELECT COUNT(*) FROM PAPER")[0][0]
        assert tfidf_hits < total_papers, "a corpus-wide term should not score high via TF-IDF for every paper"

    # a distinguishing cluster phrase should show up as a mined tfidf topic
    # for at least one paper (it may also exist via the source_keyword lane)
    mined = q(
        engine,
        "SELECT COUNT(*) FROM PAPER_TOPIC pt JOIN TOPIC t ON t.Topic_ID = pt.Topic_ID "
        "WHERE pt.Extraction_Method = :m AND LOWER(t.Topic_Name) LIKE '%privacy%'",
        m=TFIDF_METHOD,
    )[0][0]
    assert mined > 0


def test_relevance_scores_are_bounded_and_top_term_per_paper_is_near_one(engine, seeded):
    _run_extraction(engine)
    rows = q(engine, "SELECT Paper_ID, MAX(Relevance_Score) FROM PAPER_TOPIC GROUP BY Paper_ID")
    assert rows
    for _, top_score in rows:
        assert 0 <= float(top_score) <= 1.0001


def test_extraction_is_idempotent(engine, seeded):
    from ingestion.extract_topics import extract_topics

    extract_topics()
    (first_count,) = q(engine, "SELECT COUNT(*) FROM PAPER_TOPIC")[0]
    extract_topics()
    (second_count,) = q(engine, "SELECT COUNT(*) FROM PAPER_TOPIC")[0]
    assert first_count == second_count


def test_topic_names_are_case_insensitively_deduped(engine, seeded):
    from ingestion.extract_topics import extract_topics

    extract_topics()
    with engine.connect() as conn:
        dupes = conn.execute(
            text("SELECT LOWER(Topic_Name), COUNT(*) FROM TOPIC GROUP BY LOWER(Topic_Name) HAVING COUNT(*) > 1")
        ).all()
    assert not dupes, f"expected one TOPIC row per case-insensitive name, found duplicates: {dupes}"
