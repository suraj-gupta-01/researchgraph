"""
M4 Part 1 — community detection against a real PostgreSQL (persistence, replace
semantics, auditability) and the /communities API on top of it. The algorithmic
decisions are covered without a database in test_community_core.py; this file
is about what gets stored and served.

Runs on the synthetic dev corpus, which plants four author clusters (privacy,
healthcare, edge, non-IID) that 80% of each paper's authors are drawn from.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from tests.conftest import q


@pytest.fixture(scope="module")
def run(seeded, mongo):
    """Topic extraction first, exactly as the real pipeline orders it, then one run."""
    from graph.communities import detect_and_store
    from ingestion.extract_topics import extract_topics

    extract_topics()
    return detect_and_store()


def _partition(engine) -> set[frozenset[int]]:
    groups: dict[int, set[int]] = {}
    for cid, aid in q(engine, "SELECT Community_ID, Author_ID FROM COMMUNITY_MEMBER"):
        groups.setdefault(cid, set()).add(aid)
    return {frozenset(g) for g in groups.values()}


# ============================================================
# Persistence
# ============================================================

def test_run_persists_what_it_reports(engine, run):
    assert run["communities_kept"] >= 2, "the dev corpus plants four clusters; expected several communities"
    assert q(engine, "SELECT COUNT(*) FROM RESEARCH_COMMUNITY")[0][0] == run["communities_kept"]
    assert q(engine, "SELECT COUNT(*) FROM COMMUNITY_MEMBER")[0][0] == run["authors_assigned"]
    assert run["authors_assigned"] + run["authors_unassigned"] == run["graph"]["authors"]


def test_communities_meet_min_size_and_authors_belong_to_one_community(engine, run):
    from graph.community_core import DEFAULT_MIN_SIZE

    sizes = [r[0] for r in q(engine, "SELECT COUNT(*) FROM COMMUNITY_MEMBER GROUP BY Community_ID")]
    assert sizes and min(sizes) >= DEFAULT_MIN_SIZE
    assert q(engine, "SELECT Author_ID FROM COMMUNITY_MEMBER GROUP BY Author_ID HAVING COUNT(*) > 1") == []


def test_run_is_timestamped_and_records_its_parameters(engine, run):
    from graph.community_core import DEFAULT_RESOLUTION, DEFAULT_SEED, algorithm_label

    dates, algos = q(engine, "SELECT COUNT(DISTINCT Detection_Date), COUNT(DISTINCT Algorithm) FROM RESEARCH_COMMUNITY")[0]
    assert (dates, algos) == (1, 1), "every row of one run shares one Detection_Date and Algorithm"
    assert q(engine, "SELECT DISTINCT Algorithm FROM RESEARCH_COMMUNITY")[0][0] == algorithm_label(DEFAULT_RESOLUTION, DEFAULT_SEED)


def test_membership_scores_are_valid_fractions(engine, run):
    bad = q(engine, "SELECT COUNT(*) FROM COMMUNITY_MEMBER WHERE Membership_Score IS NULL OR Membership_Score < 0 OR Membership_Score > 1")
    assert bad[0][0] == 0


def test_labels_are_topic_derived_and_differ_between_communities(engine, run):
    rows = q(
        engine,
        "SELECT c.Label, t.Topic_Name FROM RESEARCH_COMMUNITY c LEFT JOIN TOPIC t ON t.Topic_ID = c.Root_Topic_ID",
    )
    labels = [r[0] for r in rows]
    assert all(labels), "every community needs a human-readable label"
    assert not any(l.startswith("Community ") for l in labels), "topic extraction ran, so no fallback labels expected"
    assert len(set(labels)) >= 2, "labels must actually vary with the community's topics"
    # 'federated learning' is on every paper of the dev corpus, so it is each community's root topic.
    assert all((r[1] or "").lower() == "federated learning" for r in rows)
    assert all(l.lower().startswith("federated learning") for l in labels)


def test_run_summary_is_snapshotted_to_mongo_and_matches_postgres(engine, run, mongo):
    doc = mongo["graph_snapshot"].find_one({"_id": "communities"})
    assert doc is not None and doc["algorithm"] == run["algorithm"]
    db_ids = {r[0] for r in q(engine, "SELECT Community_ID FROM RESEARCH_COMMUNITY")}
    assert {c["community_id"] for c in doc["communities"]} == db_ids
    (stamp,) = q(engine, "SELECT DISTINCT Detection_Date FROM RESEARCH_COMMUNITY")[0]
    assert datetime.fromisoformat(doc["detected_at"]) == stamp


def test_dry_run_writes_nothing(engine, run, mongo):
    from graph.communities import detect_and_store

    before = (_partition(engine), q(engine, "SELECT MIN(Community_ID), MAX(Community_ID) FROM RESEARCH_COMMUNITY")[0])
    summary = detect_and_store(dry_run=True, resolution=2.0)
    after = (_partition(engine), q(engine, "SELECT MIN(Community_ID), MAX(Community_ID) FROM RESEARCH_COMMUNITY")[0])
    assert before == after
    assert summary["dry_run"] is True and all(c["community_id"] is None for c in summary["communities"])
    assert mongo["graph_snapshot"].find_one({"_id": "communities"})["dry_run"] is False


# ============================================================
# API
# ============================================================

def test_list_communities_largest_first_with_members(client, run):
    r = client.get("/communities", params={"limit": 100}).json()
    assert r["total"] == run["communities_kept"] == len(r["items"])
    sizes = [i["member_count"] for i in r["items"]]
    assert sizes == sorted(sizes, reverse=True)
    for item in r["items"]:
        assert item["label"] and item["paper_count"] > 0
        assert 0 < len(item["top_members"]) <= 5
        assert item["matched_papers"] is None                      # no query, no match counts
    assert r["query"] is None and r["search_meta"] is None


def test_top_members_parameter_controls_member_count(client, run):
    none = client.get("/communities", params={"top_members": 0}).json()
    assert all(i["top_members"] == [] for i in none["items"])
    two = client.get("/communities", params={"top_members": 2}).json()
    assert all(len(i["top_members"]) == 2 for i in two["items"])


def test_topic_search_returns_matching_communities_ranked_by_matched_papers(client, run):
    r = client.get("/communities", params={"q": "federated learning", "limit": 100}).json()
    assert r["total"] > 0 and r["query"] == "federated learning" and r["search_meta"]["matched_via"]
    matched = [i["matched_papers"] for i in r["items"]]
    assert all(m and m > 0 for m in matched) and matched == sorted(matched, reverse=True)
    # 'federated learning' tags every paper in the dev corpus, so every paper a
    # member wrote is a match: matched_papers must equal the community's paper_count.
    for item in r["items"]:
        assert item["matched_papers"] == item["paper_count"]
        assert 0 < item["matched_members"] <= item["member_count"]


def test_narrower_search_never_matches_more_than_a_community_wrote(client, run):
    r = client.get("/communities", params={"q": "medical imaging", "limit": 100}).json()
    assert r["total"] > 0
    for item in r["items"]:
        assert 0 < item["matched_papers"] <= item["paper_count"]
    matched = [i["matched_papers"] for i in r["items"]]
    assert matched == sorted(matched, reverse=True)


def test_search_with_no_match_is_empty_not_an_error(client, run):
    r = client.get("/communities", params={"q": "qwertyuiop zxcvbnm"})
    assert r.status_code == 200
    assert r.json()["total"] == 0 and r.json()["items"] == []


def test_search_input_is_bound_not_interpolated(client, engine, run):
    for hostile in ["'; DROP TABLE research_community; --", "100%", "a_b\\", "\") OR 1=1 --"]:
        assert client.get("/communities", params={"q": hostile}).status_code == 200
    assert q(engine, "SELECT COUNT(*) FROM RESEARCH_COMMUNITY")[0][0] == run["communities_kept"]


def test_community_detail(client, engine, run):
    top = client.get("/communities", params={"limit": 1}).json()["items"][0]
    d = client.get(f"/communities/{top['community_id']}").json()
    assert d["community_id"] == top["community_id"] and d["label"] == top["label"]
    assert d["member_count"] == q(engine, "SELECT COUNT(*) FROM COMMUNITY_MEMBER WHERE Community_ID = :c", c=top["community_id"])[0][0]
    assert d["year_min"] <= d["year_max"]
    assert d["top_institutions"] and d["top_institutions"][0]["member_count"] >= 1
    assert d["topics_status"] == "ok" and d["topics"]
    assert d["topics"][0]["topic_id"] == d["root_topic_id"]        # root topic leads the evidence
    assert len(d["top_members"]) <= 10 and d["algorithm"].startswith("louvain(")


def test_detail_withholds_label_evidence_from_a_different_run(client, run, mongo):
    top = client.get("/communities", params={"limit": 1}).json()["items"][0]
    snap = mongo["graph_snapshot"]
    original = snap.find_one({"_id": "communities"})["detected_at"]
    try:
        snap.update_one({"_id": "communities"}, {"$set": {"detected_at": "2001-01-01T00:00:00+00:00"}})
        d = client.get(f"/communities/{top['community_id']}").json()
        assert d["topics"] == [] and d["topics_status"] == "stale"
        snap.delete_one({"_id": "communities"})
        assert client.get(f"/communities/{top['community_id']}").json()["topics_status"] == "missing"
    finally:
        snap.update_one({"_id": "communities"}, {"$set": {"detected_at": original}}, upsert=True)


def test_members_are_paginated_complete_and_ordered(client, engine, run):
    biggest = client.get("/communities", params={"limit": 1}).json()["items"][0]
    cid, seen, offset = biggest["community_id"], [], 0
    while True:
        r = client.get(f"/communities/{cid}/members", params={"limit": 5, "offset": offset}).json()
        assert r["total"] == biggest["member_count"]
        seen += r["items"]
        offset += 5
        if offset >= r["total"]:
            break
    ids = [m["author_id"] for m in seen]
    assert len(ids) == len(set(ids)) == biggest["member_count"]
    expected = {r[0] for r in q(engine, "SELECT Author_ID FROM COMMUNITY_MEMBER WHERE Community_ID = :c", c=cid)}
    assert set(ids) == expected
    counts = [m["paper_count"] for m in seen]
    assert counts == sorted(counts, reverse=True)
    assert all(0 <= m["membership_score"] <= 1 for m in seen)


def test_unknown_and_malformed_ids_and_params(client, run):
    assert client.get("/communities/99999999").status_code == 404
    assert client.get("/communities/99999999/members").status_code == 404
    assert client.get("/communities/0").status_code == 422
    assert client.get("/communities/abc").status_code == 422
    assert client.get("/communities/99999999999").status_code == 422        # beyond int4: rejected, not a 500
    assert client.get("/communities", params={"top_members": 99}).status_code == 422
    assert client.get("/communities", params={"limit": 0}).status_code == 422
    assert client.get("/communities", params={"q": ""}).status_code == 422


# ============================================================
# Replace semantics (last: it re-runs detection and renumbers communities)
# ============================================================

def test_rerun_replaces_the_previous_run_and_reproduces_the_partition(engine, run):
    from graph.communities import detect_and_store

    before = _partition(engine)
    old_stamp = q(engine, "SELECT MAX(Detection_Date) FROM RESEARCH_COMMUNITY")[0][0]
    detect_and_store()
    assert _partition(engine) == before, "same data + parameters must give the same communities"
    assert q(engine, "SELECT COUNT(*) FROM RESEARCH_COMMUNITY")[0][0] == run["communities_kept"], "replaced, not appended"
    assert q(engine, "SELECT COUNT(DISTINCT Detection_Date) FROM RESEARCH_COMMUNITY")[0][0] == 1
    assert q(engine, "SELECT MAX(Detection_Date) FROM RESEARCH_COMMUNITY")[0][0] > old_stamp


def test_a_failed_run_leaves_the_previous_run_in_place(engine, run, monkeypatch):
    import graph.communities as communities

    before = _partition(engine)
    real_store = communities._store

    def store_then_fail(*args, **kwargs):
        real_store(*args, **kwargs)            # old run deleted, new run inserted ...
        raise RuntimeError("simulated failure after writing")   # ... and then the job dies

    monkeypatch.setattr(communities, "_store", store_then_fail)
    with pytest.raises(RuntimeError):
        communities.detect_and_store()
    assert _partition(engine) == before, "the delete+insert must be one transaction"
    assert q(engine, "SELECT COUNT(DISTINCT Detection_Date) FROM RESEARCH_COMMUNITY")[0][0] == 1
