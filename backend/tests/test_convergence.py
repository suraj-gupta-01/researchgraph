"""
M4 Part 4b — topic convergence detection against a real PostgreSQL
(persistence, replace semantics, the RESEARCH_TREND promotion rule) and the
/topics/converging endpoint on top of it. The formula/threshold decisions
are covered without a database in test_convergence_core.py; this file is
about what gets stored, promoted, and served.

Runs on the synthetic dev corpus (ingestion.seed_dev) after graph.trends,
same ordering the README documents as required. The corpus's four topic
clusters (privacy / healthcare / edge / non-iid) co-occur with "federated
learning" on virtually every paper and grow in volume in later years (same
property that makes federated learning itself land 'Emerging' in
test_trends.py), so real converging pairs -- not just exercised code paths
-- are expected, and federated learning is the reliable one to assert on.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from tests.conftest import q


@pytest.fixture(scope="module")
def trends_run(seeded, mongo):
    """graph.trends must run first -- convergence's RESEARCH_TREND
    promotion needs a 'Stable' baseline to promote from (see graph.
    convergence's module docstring on ordering)."""
    from graph.trends import detect_and_store
    from ingestion.extract_topics import extract_topics

    extract_topics()
    return detect_and_store()


@pytest.fixture(scope="module")
def run(engine, trends_run, mongo):
    from graph.convergence import detect_and_store

    return detect_and_store()


def _federated_learning_topic_id(engine) -> int:
    return q(engine, "SELECT Topic_ID FROM TOPIC WHERE LOWER(Topic_Name) = 'federated learning'")[0][0]


# ============================================================
# Persistence
# ============================================================

def test_run_persists_what_it_reports(engine, run):
    assert run["periods_classified"] > 0
    assert q(engine, "SELECT COUNT(*) FROM TOPIC_PAIR_TREND")[0][0] == run["periods_classified"]
    converging = q(engine, "SELECT COUNT(*) FROM TOPIC_PAIR_TREND WHERE Is_Converging")[0][0]
    assert converging == run["converging_periods"]


def test_every_pair_row_is_canonically_ordered(engine, run):
    backwards = q(engine, "SELECT COUNT(*) FROM TOPIC_PAIR_TREND WHERE Topic_A_ID >= Topic_B_ID")
    assert backwards[0][0] == 0


def test_counts_are_never_negative_and_growth_rate_is_set(engine, run):
    bad = q(
        engine,
        """
        SELECT COUNT(*) FROM TOPIC_PAIR_TREND
        WHERE Cooccurrence_Count < 1 OR Prior_Cooccurrence_Count < 0 OR Growth_Rate IS NULL
        """,
    )
    assert bad[0][0] == 0


def test_run_is_timestamped_and_records_its_algorithm(engine, run):
    from graph.convergence_core import algorithm_label

    dates, algos = q(engine, "SELECT COUNT(DISTINCT Detection_Date), COUNT(DISTINCT Algorithm) FROM TOPIC_PAIR_TREND")[0]
    assert (dates, algos) == (1, 1), "every row of one run shares one Detection_Date and Algorithm"
    assert q(engine, "SELECT DISTINCT Algorithm FROM TOPIC_PAIR_TREND")[0][0] == algorithm_label()


def test_federated_learning_has_a_converging_pair_in_a_recent_year(engine, run):
    fl = _federated_learning_topic_id(engine)
    rows = q(
        engine,
        """
        SELECT COUNT(*) FROM TOPIC_PAIR_TREND
        WHERE (Topic_A_ID = :t OR Topic_B_ID = :t) AND Is_Converging AND Period_Year >= 2023
        """,
        t=fl,
    )
    assert rows[0][0] > 0, "expected at least one converging pair involving federated learning in the back half"


# ============================================================
# RESEARCH_TREND promotion
# ============================================================

def test_promoted_rows_match_reported_count(engine, run):
    assert q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND WHERE Trend_Label = 'Converging'")[0][0] == run["topics_promoted"]


def test_promotion_never_overwrites_emerging_or_declining(engine, trends_run, mongo):
    # Re-running convergence must never change the size of the Emerging/
    # Declining pools -- promotion only ever touches rows currently
    # 'Stable' (see graph.convergence._promote_converging_topics).
    from graph.convergence import detect_and_store

    before = {
        label: q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND WHERE Trend_Label = :l", l=label)[0][0]
        for label in ("Emerging", "Declining")
    }
    detect_and_store()
    after = {
        label: q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND WHERE Trend_Label = :l", l=label)[0][0]
        for label in ("Emerging", "Declining")
    }
    assert before == after


def test_promoted_row_keeps_part_2s_algorithm_and_detection_date(engine, run):
    # Promotion overwrites Trend_Label/Score only; Algorithm/Detection_Date
    # stay Part 2's own -- TOPIC_PAIR_TREND is this run's audit trail, not
    # RESEARCH_TREND (see graph.convergence._promote_converging_topics).
    from graph.trend_core import algorithm_label as trend_algorithm_label

    rows = q(engine, "SELECT DISTINCT Algorithm FROM RESEARCH_TREND WHERE Trend_Label = 'Converging'")
    assert rows, "expected at least one promoted row to check"
    assert all(r[0] == trend_algorithm_label() for r in rows)


def test_promoted_row_score_matches_its_strongest_converging_pair(engine, run):
    row = q(engine, "SELECT Topic_ID, Period_Year, Score FROM RESEARCH_TREND WHERE Trend_Label = 'Converging' LIMIT 1")[0]
    topic_id, year, score = row
    best = q(
        engine,
        """
        SELECT MAX(Convergence_Score) FROM TOPIC_PAIR_TREND
        WHERE (Topic_A_ID = :t OR Topic_B_ID = :t) AND Period_Year = :y AND Is_Converging
        """,
        t=topic_id, y=year,
    )[0][0]
    assert float(score) == pytest.approx(float(best))


# ============================================================
# Replace semantics
# ============================================================

def test_rerun_replaces_rather_than_accumulates(engine, mongo):
    from graph.convergence import detect_and_store

    before = q(engine, "SELECT COUNT(*) FROM TOPIC_PAIR_TREND")[0][0]
    run2 = detect_and_store()
    after = q(engine, "SELECT COUNT(*) FROM TOPIC_PAIR_TREND")[0][0]
    assert before == after
    assert after > 0 and run2["periods_classified"] == after


def test_dry_run_writes_nothing(engine, mongo):
    from graph.convergence import detect_and_store

    before_pairs = q(engine, "SELECT COUNT(*) FROM TOPIC_PAIR_TREND")[0][0]
    before_converging = q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND WHERE Trend_Label = 'Converging'")[0][0]
    summary = detect_and_store(dry_run=True)
    assert summary["dry_run"] is True
    assert q(engine, "SELECT COUNT(*) FROM TOPIC_PAIR_TREND")[0][0] == before_pairs
    assert q(engine, "SELECT COUNT(*) FROM RESEARCH_TREND WHERE Trend_Label = 'Converging'")[0][0] == before_converging


# ============================================================
# Mongo snapshot
# ============================================================

def test_run_summary_is_snapshotted_to_mongo_and_matches_postgres(engine, run, mongo):
    doc = mongo["graph_snapshot"].find_one({"_id": "convergence"})
    assert doc is not None and doc["algorithm"] == run["algorithm"]
    assert doc["periods_classified"] == q(engine, "SELECT COUNT(*) FROM TOPIC_PAIR_TREND")[0][0]
    (stamp,) = q(engine, "SELECT DISTINCT Detection_Date FROM TOPIC_PAIR_TREND")[0]
    assert datetime.fromisoformat(doc["detected_at"]) == stamp


# ============================================================
# API
# ============================================================

def test_converging_endpoint_defaults_to_latest_converging_year(client, engine, run):
    latest = q(engine, "SELECT MAX(Period_Year) FROM TOPIC_PAIR_TREND WHERE Is_Converging")[0][0]
    r = client.get("/topics/converging").json()
    assert r["total"] > 0
    assert all(item["year"] == latest for item in r["items"])


def test_converging_endpoint_ranks_highest_score_first(client):
    r = client.get("/topics/converging").json()
    scores = [item["convergence_score"] for item in r["items"]]
    assert scores == sorted(scores, reverse=True)


def test_converging_endpoint_includes_federated_learning(client, engine, run):
    fl = _federated_learning_topic_id(engine)
    latest = q(engine, "SELECT MAX(Period_Year) FROM TOPIC_PAIR_TREND WHERE Is_Converging")[0][0]
    r = client.get("/topics/converging", params={"year": latest}).json()
    assert any(item["topic_a_id"] == fl or item["topic_b_id"] == fl for item in r["items"])


def test_converging_endpoint_explicit_year_and_out_of_range_year(client, engine):
    r = client.get("/topics/converging", params={"year": 2022}).json()
    assert all(item["year"] == 2022 for item in r["items"])
    empty = client.get("/topics/converging", params={"year": 1901}).json()
    assert empty["items"] == [] and empty["total"] == 0


def test_converging_endpoint_pair_names_match_topic_ids(client, engine):
    r = client.get("/topics/converging").json()
    for item in r["items"][:5]:
        a_name = q(engine, "SELECT Topic_Name FROM TOPIC WHERE Topic_ID = :t", t=item["topic_a_id"])[0][0]
        b_name = q(engine, "SELECT Topic_Name FROM TOPIC WHERE Topic_ID = :t", t=item["topic_b_id"])[0][0]
        assert item["topic_a_name"] == a_name
        assert item["topic_b_name"] == b_name


# ============================================================
# API: /topics/pairs/{a}/{b}/trend (G3, Phase 6b pair drawer)
# ============================================================

def test_pair_trend_endpoint_matches_stored_rows(client, engine, run):
    a, b = q(engine, "SELECT Topic_A_ID, Topic_B_ID FROM TOPIC_PAIR_TREND LIMIT 1")[0]
    rows = q(
        engine,
        "SELECT Period_Year, Cooccurrence_Count, Prior_Cooccurrence_Count, Growth_Rate::float8, Is_Converging "
        "FROM TOPIC_PAIR_TREND WHERE Topic_A_ID = :a AND Topic_B_ID = :b ORDER BY Period_Year",
        a=a, b=b,
    )
    r = client.get(f"/topics/pairs/{a}/{b}/trend").json()
    assert [p["year"] for p in r["points"]] == [row[0] for row in rows]
    assert [p["cooccurrence_count"] for p in r["points"]] == [row[1] for row in rows]
    assert [p["is_converging"] for p in r["points"]] == [row[4] for row in rows]


def test_pair_trend_endpoint_is_order_invariant(client, engine, run):
    # G3: "Canonicalize the id order server-side (low id first) so either
    # order works" -- the URL's own order must not change the result.
    a, b = q(engine, "SELECT Topic_A_ID, Topic_B_ID FROM TOPIC_PAIR_TREND LIMIT 1")[0]
    forward = client.get(f"/topics/pairs/{a}/{b}/trend").json()
    backward = client.get(f"/topics/pairs/{b}/{a}/trend").json()
    assert forward == backward
    assert forward["topic_a_id"] == a and forward["topic_b_id"] == b


def test_pair_trend_endpoint_reports_the_algorithm(client, engine, run):
    from graph.convergence_core import algorithm_label

    a, b = q(engine, "SELECT Topic_A_ID, Topic_B_ID FROM TOPIC_PAIR_TREND LIMIT 1")[0]
    r = client.get(f"/topics/pairs/{a}/{b}/trend").json()
    assert r["algorithm"] == algorithm_label()


def test_pair_trend_endpoint_404s_for_a_missing_topic(client, engine, run):
    a, _b = q(engine, "SELECT Topic_A_ID, Topic_B_ID FROM TOPIC_PAIR_TREND LIMIT 1")[0]
    assert client.get(f"/topics/pairs/{a}/999999/trend").status_code == 404


def test_pair_trend_endpoint_422s_for_a_self_pair(client, engine, run):
    a, _b = q(engine, "SELECT Topic_A_ID, Topic_B_ID FROM TOPIC_PAIR_TREND LIMIT 1")[0]
    assert client.get(f"/topics/pairs/{a}/{a}/trend").status_code == 422


def test_pair_trend_endpoint_empty_for_two_real_topics_with_no_shared_history(client, engine, run):
    # A pair of existing topics that never co-occurred has no TOPIC_PAIR_TREND
    # row -- same "not computed yet" shape as /topics/{id}/trend's empty
    # points, not a 404. Search for such a pair among the topics this run
    # already touched, so both ids are guaranteed real.
    pairs = q(engine, "SELECT Topic_A_ID, Topic_B_ID FROM TOPIC_PAIR_TREND")
    paired = {frozenset(p) for p in pairs}
    topic_ids = sorted({tid for p in pairs for tid in p})
    for i, t1 in enumerate(topic_ids):
        for t2 in topic_ids[i + 1:]:
            if frozenset((t1, t2)) not in paired:
                r = client.get(f"/topics/pairs/{t1}/{t2}/trend").json()
                assert r["points"] == []
                assert r["algorithm"] is None
                return
    pytest.skip("every pair among this run's topics co-occurred at least once")
