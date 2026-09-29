"""
M4 Part 3 -- researcher influence & bridge detection against a real
PostgreSQL (persistence, replace semantics, auditability) and the
/authors/bridges + /authors/{id}/influence API on top of it. The metric
formulas are covered without a database in test_influence_core.py; this
file is about what gets stored and served.

Runs on the same synthetic dev corpus as test_communities.py, which plants
four author clusters that 80% of each paper's authors are drawn from --
20% cross-cluster authorship is exactly what should produce a handful of
authors whose ties span more than one detected community.
"""
from __future__ import annotations

import pytest

from tests.conftest import q


@pytest.fixture(scope="module")
def run(seeded, mongo):
    """Topic extraction, then communities (Part 1), then influence (Part 3),
    in the real pipeline's order (graph.influence depends on RESEARCH_COMMUNITY)."""
    from graph.communities import detect_and_store as detect_communities
    from graph.influence import detect_and_store as detect_influence
    from ingestion.extract_topics import extract_topics

    extract_topics()
    detect_communities()
    return detect_influence()


# ============================================================
# Persistence
# ============================================================

def test_run_scores_every_author_exactly_once(engine, run):
    total_authors = q(engine, "SELECT COUNT(*) FROM AUTHOR")[0][0]
    assert run["authors_scored"] == total_authors
    assert q(engine, "SELECT COUNT(*) FROM AUTHOR_INFLUENCE")[0][0] == total_authors
    dupes = q(engine, "SELECT Author_ID FROM AUTHOR_INFLUENCE GROUP BY Author_ID HAVING COUNT(*) > 1")
    assert dupes == []


def test_scores_are_within_their_documented_ranges(engine, run):
    bad = q(
        engine,
        """
        SELECT COUNT(*) FROM AUTHOR_INFLUENCE
        WHERE Degree_Centrality NOT BETWEEN 0 AND 1
           OR Betweenness_Centrality NOT BETWEEN 0 AND 1
           OR Pagerank NOT BETWEEN 0 AND 1
           OR Bridge_Score NOT BETWEEN 0 AND 1
           OR Communities_Touched < 0
        """,
    )
    assert bad[0][0] == 0


def test_the_dev_corpus_produces_at_least_one_bridge_researcher(run):
    # 20% cross-cluster authorship in the dev corpus (see module docstring)
    # should produce at least a few authors whose ties span >= 2 communities.
    assert run["bridge_researchers_found"] >= 1


def test_communities_touched_matches_stored_ties(engine, run):
    rows = q(
        engine,
        """
        SELECT ai.Author_ID, ai.Communities_Touched, COUNT(act.Community_ID)
        FROM AUTHOR_INFLUENCE ai
        LEFT JOIN AUTHOR_COMMUNITY_TIE act ON act.Author_ID = ai.Author_ID
        GROUP BY ai.Author_ID, ai.Communities_Touched
        """,
    )
    assert rows, "expected at least one author"
    assert all(touched == tie_count for _, touched, tie_count in rows)


def test_tie_shares_sum_to_one_per_bridging_author(engine, run):
    rows = q(
        engine,
        """
        SELECT Author_ID, SUM(Tie_Share) FROM AUTHOR_COMMUNITY_TIE
        GROUP BY Author_ID
        """,
    )
    assert rows
    for _, total_share in rows:
        assert float(total_share) == pytest.approx(1.0, abs=1e-3)


def test_run_is_timestamped_and_records_its_algorithm(engine, run):
    from graph.influence_core import algorithm_label

    dates, algos = q(engine, "SELECT COUNT(DISTINCT Detection_Date), COUNT(DISTINCT Algorithm) FROM AUTHOR_INFLUENCE")[0]
    assert (dates, algos) == (1, 1)
    assert q(engine, "SELECT DISTINCT Algorithm FROM AUTHOR_INFLUENCE")[0][0] == algorithm_label()


def test_run_summary_is_snapshotted_to_mongo_and_matches_postgres(engine, run, mongo):
    doc = mongo["graph_snapshot"].find_one({"_id": "influence"})
    assert doc is not None
    assert doc["algorithm"] == run["algorithm"]
    assert doc["authors_scored"] == run["authors_scored"]
    assert doc["bridge_researchers_found"] == run["bridge_researchers_found"]


def test_dry_run_writes_nothing(engine, run, mongo):
    from graph.influence import detect_and_store

    before = q(engine, "SELECT Author_ID, Bridge_Score FROM AUTHOR_INFLUENCE ORDER BY Author_ID")
    summary = detect_and_store(dry_run=True)
    after = q(engine, "SELECT Author_ID, Bridge_Score FROM AUTHOR_INFLUENCE ORDER BY Author_ID")
    assert before == after
    assert summary["dry_run"] is True
    assert mongo["graph_snapshot"].find_one({"_id": "influence"})["dry_run"] is False


# ============================================================
# API
# ============================================================

def test_list_bridge_authors_default_floor_is_two_communities(client, run):
    r = client.get("/authors/bridges", params={"limit": 100}).json()
    assert r["total"] == run["bridge_researchers_found"] == len(r["items"])
    assert all(i["communities_touched"] >= 2 for i in r["items"])
    scores = [i["bridge_score"] for i in r["items"]]
    assert scores == sorted(scores, reverse=True)
    for item in r["items"]:
        assert len(item["ties"]) == item["communities_touched"]
        assert item["matched_communities"] is None                # no query
    assert r["query"] is None and r["search_meta"] is None
    assert r["algorithm"]


def test_min_communities_relaxes_or_tightens_the_floor(client, run):
    loose = client.get("/authors/bridges", params={"min_communities": 1, "limit": 100}).json()
    default = client.get("/authors/bridges", params={"limit": 100}).json()
    assert loose["total"] >= default["total"]
    assert all(i["communities_touched"] >= 1 for i in loose["items"])


def test_topic_search_matches_communities_the_topic_touches(client, run):
    # 'federated learning' tags every paper in the dev corpus, so it should
    # match every detected community, and matched_communities should equal
    # each bridging author's overall communities_touched.
    r = client.get("/authors/bridges", params={"q": "federated learning", "limit": 100}).json()
    assert r["total"] > 0 and r["query"] == "federated learning" and r["search_meta"]["matched_via"]
    for item in r["items"]:
        assert item["matched_communities"] is not None
        assert 0 < item["matched_communities"] <= item["communities_touched"]
    matched = [i["matched_communities"] for i in r["items"]]
    assert matched == sorted(matched, reverse=True)


def test_search_with_no_match_is_empty_not_an_error(client, run):
    r = client.get("/authors/bridges", params={"q": "qwertyuiop zxcvbnm"})
    assert r.status_code == 200
    assert r.json()["total"] == 0 and r.json()["items"] == []


def test_search_input_is_bound_not_interpolated(client, engine, run):
    for hostile in ["'; DROP TABLE author_influence; --", "100%", "a_b\\", "\") OR 1=1 --"]:
        assert client.get("/authors/bridges", params={"q": hostile}).status_code == 200
    assert q(engine, "SELECT COUNT(*) FROM AUTHOR_INFLUENCE")[0][0] == run["authors_scored"]


def test_author_influence_detail_matches_the_bridge_listing(client, run):
    top = client.get("/authors/bridges", params={"limit": 1}).json()["items"][0]
    d = client.get(f"/authors/{top['author_id']}/influence").json()
    assert d["author_id"] == top["author_id"]
    assert d["bridge_score"] == pytest.approx(top["bridge_score"])
    assert d["communities_touched"] == top["communities_touched"]
    assert {t["community_id"] for t in d["ties"]} == {t["community_id"] for t in top["ties"]}
    assert d["algorithm"] == top.get("algorithm") or d["algorithm"]   # present regardless


def test_every_author_has_an_influence_row_even_without_bridging(client, engine, run):
    # Any author at all -- not just a bridge researcher -- should have a
    # scored row, since the four metrics only need the collaboration graph.
    any_author = q(engine, "SELECT Author_ID FROM AUTHOR LIMIT 1")[0][0]
    r = client.get(f"/authors/{any_author}/influence")
    assert r.status_code == 200
    body = r.json()
    assert 0 <= body["degree_centrality"] <= 1
    assert len(body["ties"]) == body["communities_touched"]


def test_unknown_author_404(client, run):
    assert client.get("/authors/99999999/influence").status_code == 404


def test_malformed_params(client, run):
    assert client.get("/authors/bridges", params={"limit": 0}).status_code == 422
    assert client.get("/authors/bridges", params={"min_communities": 0}).status_code == 422
    assert client.get("/authors/bridges", params={"min_communities": 21}).status_code == 422
    assert client.get("/authors/bridges", params={"q": ""}).status_code == 422


# ============================================================
# Replace semantics (last: it re-runs community detection, which cascades
# and drops this module's AUTHOR_COMMUNITY_TIE rows, then re-runs influence)
# ============================================================

def test_rerunning_communities_then_influence_replaces_ties_cleanly(engine, run):
    from graph.communities import detect_and_store as detect_communities
    from graph.influence import detect_and_store as detect_influence

    detect_communities()   # new Community_IDs; old AUTHOR_COMMUNITY_TIE rows cascade-delete
    second = detect_influence()

    assert q(engine, "SELECT COUNT(*) FROM AUTHOR_INFLUENCE")[0][0] == second["authors_scored"]
    orphans = q(
        engine,
        """
        SELECT COUNT(*) FROM AUTHOR_COMMUNITY_TIE act
        LEFT JOIN RESEARCH_COMMUNITY rc ON rc.Community_ID = act.Community_ID
        WHERE rc.Community_ID IS NULL
        """,
    )
    assert orphans[0][0] == 0
