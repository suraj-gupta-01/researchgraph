"""
Tests for M3 Part 2 — graph construction (F2/F4/G4). Runs against the same
synthetic dev corpus used elsewhere (tests.conftest.seeded), with topic
extraction run first so PAPER_TOPIC (and therefore the has_topic edges /
shared-topic signal) is populated the way a real pipeline run would leave it.
"""
from __future__ import annotations

from tests.conftest import q


def _ensure_topics_extracted():
    from ingestion.extract_topics import extract_topics

    extract_topics()


def _full_graph():
    from graph.build_graph import build_full_graph

    _ensure_topics_extracted()
    return build_full_graph()


def _collab_graph():
    from graph.build_graph import build_author_collaboration_graph

    _ensure_topics_extracted()
    return build_author_collaboration_graph()


# ============================================================
# Full heterogeneous graph
# ============================================================

def test_full_graph_node_counts_match_relational_tables(engine, seeded):
    from graph.build_graph import full_graph_summary

    g = _full_graph()
    counts = full_graph_summary(g)["node_counts"]

    assert counts.get("author", 0) == q(engine, "SELECT COUNT(*) FROM AUTHOR")[0][0]
    assert counts.get("paper", 0) == q(engine, "SELECT COUNT(*) FROM PAPER")[0][0]
    assert counts.get("institution", 0) == q(engine, "SELECT COUNT(*) FROM INSTITUTION")[0][0]
    assert counts.get("topic", 0) == q(engine, "SELECT COUNT(*) FROM TOPIC")[0][0]
    assert counts.get("venue", 0) == q(engine, "SELECT COUNT(*) FROM VENUE")[0][0]
    assert counts["author"] > 0 and counts["paper"] > 0 and counts["topic"] > 0


def test_full_graph_edge_counts_match_relational_tables(engine, seeded):
    from graph.build_graph import (
        EDGE_AFFILIATION,
        EDGE_AUTHORSHIP,
        EDGE_CITES,
        EDGE_HAS_TOPIC,
        EDGE_PUBLISHED_IN,
        full_graph_summary,
    )

    g = _full_graph()
    counts = full_graph_summary(g)["edge_counts"]

    assert counts.get(EDGE_AUTHORSHIP, 0) == q(engine, "SELECT COUNT(*) FROM AUTHORSHIP")[0][0]
    assert counts.get(EDGE_CITES, 0) == q(engine, "SELECT COUNT(*) FROM CITATION")[0][0]
    assert counts.get(EDGE_HAS_TOPIC, 0) == q(engine, "SELECT COUNT(*) FROM PAPER_TOPIC")[0][0]
    assert counts.get(EDGE_AFFILIATION, 0) == q(engine, "SELECT COUNT(*) FROM AUTHOR_INSTITUTION")[0][0]
    assert counts.get(EDGE_PUBLISHED_IN, 0) == q(
        engine, "SELECT COUNT(*) FROM PAPER WHERE Venue_ID IS NOT NULL"
    )[0][0]
    # Sanity: every one of these relationships is actually populated in the
    # seeded corpus, so a bug that silently drops an edge type would show up
    # as a mismatch above, not as "both sides are zero".
    for key in (EDGE_AUTHORSHIP, EDGE_CITES, EDGE_HAS_TOPIC, EDGE_AFFILIATION, EDGE_PUBLISHED_IN):
        assert counts[key] > 0, f"expected at least one {key} edge in the seeded corpus"


def test_full_graph_citation_edges_have_no_self_loops(engine, seeded):
    from graph.build_graph import EDGE_CITES

    g = _full_graph()
    cite_edges = [(u, v) for u, v, d in g.edges(data=True) if d.get("kind") == EDGE_CITES]
    assert cite_edges
    assert all(u != v for u, v in cite_edges)


def test_full_graph_is_deterministic_across_rebuilds(engine, seeded):
    from graph.build_graph import full_graph_summary

    first = full_graph_summary(_full_graph())
    second = full_graph_summary(_full_graph())
    assert first == second


# ============================================================
# Author-collaboration graph (F2 input)
# ============================================================

def test_collaboration_graph_has_one_node_per_author(engine, seeded):
    g = _collab_graph()
    assert g.number_of_nodes() == q(engine, "SELECT COUNT(*) FROM AUTHOR")[0][0]


def test_collaboration_graph_connects_known_coauthors(engine, seeded):
    # Find a real co-authored paper straight from AUTHORSHIP, independent of
    # the graph builder, then check the corresponding authors are linked.
    pair_row = q(
        engine,
        "SELECT s1.Author_ID, s2.Author_ID FROM AUTHORSHIP s1 JOIN AUTHORSHIP s2 "
        "ON s1.Paper_ID = s2.Paper_ID AND s1.Author_ID < s2.Author_ID LIMIT 1",
    )
    assert pair_row, "seeded corpus should contain at least one multi-author paper"
    a, b = pair_row[0]

    g = _collab_graph()
    assert g.has_edge(a, b)
    assert g[a][b]["weight"] > 0
    assert g[a][b].get("coauthor_weight", 0) > 0


def test_collaboration_graph_two_distinct_wei_zhangs_stay_separate_nodes(engine, seeded):
    # seed_dev deliberately creates two different people named "Wei Zhang"
    # (see ingestion.seed_dev) who must never collapse into one node.
    # `>= 2`, not `== 2`: the random name pool can also produce a third,
    # unrelated "Wei Zhang", which must not fail this test either.
    rows = q(engine, "SELECT Author_ID FROM AUTHOR WHERE Full_Name = 'Wei Zhang'")
    assert len(rows) >= 2, "fixture should contain at least two distinct 'Wei Zhang' authors"
    ids = {r[0] for r in rows}

    g = _collab_graph()
    assert ids <= set(g.nodes())
    assert len(ids) == len(rows)


def test_collaboration_graph_weight_breakdown_sums_to_total_weight(engine, seeded):
    g = _collab_graph()
    signal_keys = ("coauthor_weight", "citation_weight", "shared_topic_weight", "institutional_weight")
    checked = 0
    for _, _, data in g.edges(data=True):
        breakdown = sum(data.get(k, 0.0) for k in signal_keys)
        assert abs(breakdown - data["weight"]) < 1e-9
        checked += 1
    assert checked > 0


def test_shared_topic_signal_excludes_the_corpus_wide_topic(engine, seeded):
    # "federated learning" is a source_keyword on essentially every paper in
    # the seeded corpus (see ingestion.seed_dev CLUSTERS), so it carries no
    # discriminative signal about which sub-community an author belongs to
    # and must be excluded by DOMINANT_TOPIC_FRACTION.
    from graph.build_graph import DOMINANT_TOPIC_FRACTION, _paper_author_map, _shared_topic_author_groups

    _ensure_topics_extracted()
    fl_topic = q(engine, "SELECT Topic_ID FROM TOPIC WHERE LOWER(Topic_Name) = 'federated learning'")
    assert fl_topic, "expected the corpus-wide keyword to exist as a TOPIC row"
    (fl_id,) = fl_topic[0]

    total_papers = q(engine, "SELECT COUNT(*) FROM PAPER")[0][0]
    tagged = q(engine, "SELECT COUNT(*) FROM PAPER_TOPIC WHERE Topic_ID = :tid", tid=fl_id)[0][0]
    assert tagged > DOMINANT_TOPIC_FRACTION * total_papers, "fixture assumption: topic should be corpus-wide"

    with engine.connect() as conn:
        paper_authors = _paper_author_map(conn)
        groups = _shared_topic_author_groups(conn, paper_authors)

    all_fl_authors = q(
        engine,
        "SELECT DISTINCT s.Author_ID FROM AUTHORSHIP s "
        "JOIN PAPER_TOPIC pt ON pt.Paper_ID = s.Paper_ID WHERE pt.Topic_ID = :tid",
        tid=fl_id,
    )
    fl_author_ids = {r[0] for r in all_fl_authors}
    assert not any(fl_author_ids <= group for group in groups), (
        "the dominant topic's author set should not appear as a shared-topic group"
    )


def test_institutional_collaboration_signal_adds_edges_beyond_coauthorship(engine, seeded):
    g = _collab_graph()
    institutional_edges = [(u, v) for u, v, d in g.edges(data=True) if d.get("institutional_weight", 0) > 0]
    assert institutional_edges, "COLLABORATION-derived rows should produce at least one institutional edge"


def test_collaboration_graph_is_deterministic_across_rebuilds(engine, seeded):
    from graph.build_graph import collaboration_graph_summary

    first = collaboration_graph_summary(_collab_graph())
    second = collaboration_graph_summary(_collab_graph())
    assert first == second


# ============================================================
# End-to-end: build_and_summarize + Mongo snapshot
# ============================================================

def test_build_and_summarize_persists_a_mongo_snapshot(engine, seeded, mongo):
    from graph.build_graph import build_and_summarize

    _ensure_topics_extracted()
    summary = build_and_summarize()
    assert summary["full_graph"]["nodes"] > 0
    assert summary["author_collaboration_graph"]["authors"] > 0

    doc = mongo["graph_snapshot"].find_one({"_id": "latest"})
    assert doc is not None
    assert doc["full_graph"] == summary["full_graph"]
    assert doc["author_collaboration_graph"] == summary["author_collaboration_graph"]
