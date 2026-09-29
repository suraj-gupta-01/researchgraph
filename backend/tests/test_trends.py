"""
M4 Part 2 — emerging-topic detection against a real PostgreSQL (persistence,
replace semantics, auditability) and the /topics trend endpoints on top of
it. The formula/threshold decisions are covered without a database in
test_trend_core.py; this file is about what gets stored and served.

Runs on the synthetic dev corpus (ingestion.seed_dev), which weights more
papers into later years and tags every paper "federated learning" — so that
topic's yearly paper counts should climb over the corpus's year range and
land it as 'Emerging' in a recent year, giving the tests a real target
instead of only checking shapes.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from tests.conftest import q


@pytest.fixture(scope="module")
def run(seeded, mongo):
    """Topic extraction first, exactly as the real pipeline orders it, then one run."""
    from graph.trends import detect_and_store
    from ingestion.extract_topics import extract_topics

    extract_topics()
    return detect_and_store()


def _federated_learning_topic_id(engine) -> int:
    return q(engine, "SELECT Topic_ID FROM TOPIC WHERE LOWER(Topic_Name) = 'federated learning'")[0][0]


# ============================================================
# Persistence
# ============================================================

def test_run_persists_what_it_reports(engine, run):
    assert run["topics_with_snapshots"] > 0
    assert q(engine, "SELECT COUNT(DISTINCT Topic_ID) FROM TOPIC_SNAPSHOT")[0][0] == run["topics_with_snapshots"]
    assert q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND")[0][0] == run["periods_classified"]
    assert sum(run["label_counts"].values()) == run["periods_classified"]


def test_every_snapshot_row_has_a_matching_trend_row(engine, run):
    # A run writes both tables from the same in-memory aggregate, so every
    # (topic, year) that got a TOPIC_SNAPSHOT row is classified too.
    missing = q(
        engine,
        """
        SELECT COUNT(*) FROM TOPIC_SNAPSHOT ts
        LEFT JOIN RESEARCH_TREND rt ON rt.Topic_ID = ts.Topic_ID AND rt.Period_Year = ts.Snapshot_Year
        WHERE rt.Topic_ID IS NULL
        """,
    )
    assert missing[0][0] == 0


def test_snapshot_counts_are_never_negative_and_growth_rate_is_set(engine, run):
    bad = q(
        engine,
        """
        SELECT COUNT(*) FROM TOPIC_SNAPSHOT
        WHERE Paper_Count < 1 OR Author_Count < 0 OR Institution_Count < 0 OR Citation_Count < 0
           OR Growth_Rate IS NULL
        """,
    )
    assert bad[0][0] == 0


def test_trend_labels_are_only_the_three_this_module_produces(engine, run):
    from graph.trend_core import TREND_DECLINING, TREND_EMERGING, TREND_STABLE

    labels = {r[0] for r in q(engine, "SELECT DISTINCT Trend_Label FROM RESEARCH_TREND")}
    assert labels <= {TREND_EMERGING, TREND_STABLE, TREND_DECLINING}
    assert "Converging" not in labels, "Converging is F5's label, not written here"


def test_run_is_timestamped_and_records_its_algorithm(engine, run):
    from graph.trend_core import algorithm_label

    dates, algos = q(engine, "SELECT COUNT(DISTINCT Detection_Date), COUNT(DISTINCT Algorithm) FROM RESEARCH_TREND")[0]
    assert (dates, algos) == (1, 1), "every row of one run shares one Detection_Date and Algorithm"
    assert q(engine, "SELECT DISTINCT Algorithm FROM RESEARCH_TREND")[0][0] == algorithm_label()


def test_federated_learning_is_emerging_in_a_recent_year(engine, run):
    # Every paper in the dev corpus is tagged 'federated learning' and the
    # corpus is weighted toward later years, so its snapshot should show
    # real growth landing on 'Emerging' somewhere in the back half.
    fl = _federated_learning_topic_id(engine)
    rows = q(engine, "SELECT Trend_Label FROM RESEARCH_TREND WHERE Topic_ID = :t AND Period_Year >= 2023", t=fl)
    assert rows, "expected snapshot years in the back half of the corpus"
    assert any(r[0] == "Emerging" for r in rows)


# ============================================================
# Replace semantics
# ============================================================

def test_rerun_replaces_rather_than_accumulates(engine, mongo):
    from graph.trends import detect_and_store

    before = q(engine, "SELECT COUNT(*) FROM TOPIC_SNAPSHOT")[0][0]
    run2 = detect_and_store()
    after = q(engine, "SELECT COUNT(*) FROM TOPIC_SNAPSHOT")[0][0]
    distinct_topics = q(engine, "SELECT COUNT(DISTINCT Topic_ID) FROM TOPIC_SNAPSHOT")[0][0]
    assert before == after
    assert after > 0 and run2["topics_with_snapshots"] == distinct_topics


def test_dry_run_writes_nothing(engine, mongo):
    from graph.trends import detect_and_store

    before_snap = q(engine, "SELECT COUNT(*) FROM TOPIC_SNAPSHOT")[0][0]
    before_trend = q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND")[0][0]
    summary = detect_and_store(dry_run=True)
    assert summary["dry_run"] is True
    assert q(engine, "SELECT COUNT(*) FROM TOPIC_SNAPSHOT")[0][0] == before_snap
    assert q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND")[0][0] == before_trend


# ============================================================
# Mongo snapshot
# ============================================================

def test_run_summary_is_snapshotted_to_mongo_and_matches_postgres(engine, run, mongo):
    doc = mongo["graph_snapshot"].find_one({"_id": "trends"})
    assert doc is not None and doc["algorithm"] == run["algorithm"]
    assert doc["periods_classified"] == q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND")[0][0]
    (stamp,) = q(engine, "SELECT DISTINCT Detection_Date FROM RESEARCH_TREND")[0]
    assert datetime.fromisoformat(doc["detected_at"]) == stamp


# ============================================================
# API
# ============================================================

def test_topic_trend_endpoint_returns_full_history(client, engine, run):
    fl = _federated_learning_topic_id(engine)
    d = client.get(f"/topics/{fl}/trend").json()
    assert d["topic_id"] == fl and d["topic_name"].lower() == "federated learning"
    assert d["algorithm"]
    years = [pt["year"] for pt in d["points"]]
    assert years == sorted(years), "points must be oldest-year-first"
    assert all(pt["trend_label"] in ("Emerging", "Stable", "Declining") for pt in d["points"])
    db_count = q(engine, "SELECT COUNT(*) FROM TOPIC_SNAPSHOT WHERE Topic_ID = :t", t=fl)[0][0]
    assert len(d["points"]) == db_count


def test_topic_trend_404s_for_unknown_topic(client):
    assert client.get("/topics/99999999/trend").status_code == 404


def test_trending_emerging_lists_federated_learning(client, engine, run):
    # federated learning's growth cools to 'Stable' by the corpus's final
    # year (real behavior, not a bug — see test_federated_learning_is_
    # emerging_in_a_recent_year), so check a year it is actually classified
    # 'Emerging' in rather than relying on the endpoint's latest-year default.
    fl = _federated_learning_topic_id(engine)
    emerging_year = q(
        engine, "SELECT MIN(Period_Year) FROM RESEARCH_TREND WHERE Topic_ID = :t AND Trend_Label = 'Emerging'", t=fl
    )[0][0]
    assert emerging_year is not None, "expected at least one Emerging year for the corpus's dominant growing topic"

    r = client.get("/topics/trending", params={"direction": "emerging", "year": emerging_year}).json()
    assert r["total"] >= 1
    assert any(item["topic_id"] == fl for item in r["items"])
    scores = [item["score"] for item in r["items"]]
    assert scores == sorted(scores, reverse=True), "emerging results rank highest growth first"


def test_trending_declining_ranks_steepest_decline_first(client):
    r = client.get("/topics/trending", params={"direction": "declining"}).json()
    growth = [item["growth_rate"] for item in r["items"]]
    assert growth == sorted(growth), "declining results rank most negative growth first"
    assert all(item["trend_label"] == "Declining" for item in r["items"])


def test_trending_explicit_year_and_out_of_range_year(client, engine):
    latest = q(engine, "SELECT MAX(Period_Year) FROM RESEARCH_TREND")[0][0]
    r = client.get("/topics/trending", params={"direction": "emerging", "year": latest}).json()
    assert all(item["year"] == latest for item in r["items"])
    empty = client.get("/topics/trending", params={"direction": "emerging", "year": 1901}).json()
    assert empty["items"] == [] and empty["total"] == 0


def test_trending_prior_year_paper_count_matches_snapshot(client, engine):
    r = client.get("/topics/trending", params={"direction": "emerging"}).json()
    for item in r["items"][:5]:
        expected = q(
            engine,
            "SELECT Paper_Count FROM TOPIC_SNAPSHOT WHERE Topic_ID = :t AND Snapshot_Year = :y",
            t=item["topic_id"], y=item["year"] - 1,
        )
        assert item["prior_year_paper_count"] == (expected[0][0] if expected else 0)
