"""
G4 -- /meta/runs, against a real PostgreSQL and the shared mongomock store.
Runs every analysis job in pipeline order once (module fixture), then checks
that the endpoint reports each run's algorithm/date/params from the Mongo
summary, agrees with the Postgres Algorithm/Detection_Date stamps, and
degrades honestly: a missing summary falls back to Postgres
(postgres_only), a summary from another run is flagged (mismatch), and a
Mongo outage is reported rather than raised.
"""
from __future__ import annotations

import copy

import pytest

from tests.conftest import q

ANALYSES = ["graph", "communities", "trends", "convergence", "influence", "provenance"]


@pytest.fixture(scope="module")
def all_runs(seeded, mongo):
    from graph.build_graph import build_and_summarize
    from graph.communities import detect_and_store as detect_communities
    from graph.convergence import detect_and_store as detect_convergence
    from graph.influence import detect_and_store as detect_influence
    from graph.trends import detect_and_store as detect_trends
    from ingestion.extract_topics import extract_topics
    from ingestion.validate_provenance import run_validation

    extract_topics()
    build_and_summarize()
    detect_communities()
    detect_trends()
    detect_convergence()
    detect_influence()
    run_validation()


def _runs(client) -> dict:
    r = client.get("/meta/runs")
    assert r.status_code == 200, r.text
    return r.json()


def _by_name(body) -> dict[str, dict]:
    return {r["analysis"]: r for r in body["runs"]}


def test_every_analysis_is_listed_once_in_pipeline_order(client, all_runs):
    body = _runs(client)
    assert [r["analysis"] for r in body["runs"]] == ANALYSES
    assert body["mongo"] == "ok"


def test_runs_report_the_algorithm_stamped_on_postgres(client, engine, all_runs):
    runs = _by_name(_runs(client))
    for name, table in [("communities", "RESEARCH_COMMUNITY"), ("trends", "RESEARCH_TREND"),
                        ("convergence", "TOPIC_PAIR_TREND"), ("influence", "AUTHOR_INFLUENCE")]:
        run = runs[name]
        assert run["status"] == "ok", (name, run)
        assert run["source"] == "mongo"
        algos = {a for (a,) in q(engine, f"SELECT DISTINCT Algorithm FROM {table}")}
        assert run["algorithm"] in algos
        assert run["postgres_rows"] == q(engine, f"SELECT COUNT(*) FROM {table} WHERE Algorithm = :a", a=run["algorithm"])[0][0]
        assert run["detected_at"] is not None


def test_params_and_counts_come_from_the_run_summary(client, all_runs):
    runs = _by_name(_runs(client))
    assert "resolution" in runs["communities"]["params"]
    assert runs["communities"]["counts"]["communities_kept"] >= 1
    assert "latest_year" in runs["trends"]["counts"]
    assert "full_graph" in runs["graph"]["details"]
    assert runs["graph"]["postgres_rows"] is None


def test_provenance_checks_keep_their_own_status(client, all_runs):
    body = _runs(client)
    assert body["provenance_checks"]
    assert {c["status"] for c in body["provenance_checks"]} <= {"pass", "fail", "warn", "skipped"}
    assert all(c["name"] for c in body["provenance_checks"])


def test_missing_summary_falls_back_to_postgres(client, mongo, all_runs):
    col = mongo["graph_snapshot"]
    saved = col.find_one({"_id": "trends"})
    col.delete_one({"_id": "trends"})
    try:
        run = _by_name(_runs(client))["trends"]
        assert run["status"] == "postgres_only"
        assert run["source"] == "postgres"
        assert run["algorithm"] and run["detected_at"]
    finally:
        col.insert_one(saved)


def test_a_summary_from_another_run_is_flagged(client, mongo, all_runs):
    col = mongo["graph_snapshot"]
    saved = col.find_one({"_id": "communities"})
    stale = copy.deepcopy(saved)
    stale["detected_at"] = "2001-01-01T00:00:00+00:00"
    col.replace_one({"_id": "communities"}, stale)
    try:
        run = _by_name(_runs(client))["communities"]
        assert run["status"] == "mismatch"
        # The method shown is the one behind the Postgres rows on screen.
        assert run["detected_at"].startswith("20") and not run["detected_at"].startswith("2001")
    finally:
        col.replace_one({"_id": "communities"}, saved)


def test_mongo_outage_is_reported_not_raised(client, all_runs, monkeypatch):
    from app import mongo_store

    def down(_ids):
        raise RuntimeError("mongo down")

    monkeypatch.setattr(mongo_store, "run_snapshots", down)
    body = _runs(client)
    assert body["mongo"] == "unavailable"
    runs = _by_name(body)
    assert runs["communities"]["status"] == "postgres_only"
    assert runs["graph"]["status"] == "not_run"      # no Postgres trace to fall back on
    assert body["provenance_checks"] == []
