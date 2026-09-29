"""
G2 -- the citation-network endpoint (/search/citation-network), against a
real PostgreSQL. Shares candidate generation and filters with /search/papers
(test_api.py already covers relevance and filtering), so this file is about
what the endpoint does with the CITATION table: which edges it draws, which
papers it leaves out, the max_nodes cap, and how community_id degrades
before graph.communities has run.

Runs on the synthetic dev corpus, same as test_api.py.
"""
from __future__ import annotations

import pytest

from tests.conftest import q


def _all_result_ids(client, query: str) -> set[int]:
    """Every /search/papers hit, paged (limit is capped at 100)."""
    ids: set[int] = set()
    offset = 0
    while True:
        body = client.get("/search/papers", params={"q": query, "limit": 100, "offset": offset}).json()
        ids |= {i["paper_id"] for i in body["items"]}
        offset += 100
        if offset >= body["total"]:
            return ids


def _get(client, **params):
    params.setdefault("q", "federated learning")
    r = client.get("/search/citation-network", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_edges_only_connect_papers_inside_the_result_set(client, engine):
    result_ids = _all_result_ids(client, "federated learning")
    body = _get(client, max_nodes=2000)
    assert body["nodes"] and body["edges"], "the seeded corpus has citations among federated-learning papers"
    node_ids = {n["paper_id"] for n in body["nodes"]}
    assert node_ids <= result_ids
    for e in body["edges"]:
        assert e["citing_id"] in node_ids and e["cited_id"] in node_ids
        assert e["citing_id"] != e["cited_id"]


def test_isolated_result_set_papers_are_left_out(client):
    """A paper in the result set with no citation link to another paper in
    the set has nothing to draw and must not appear as a lone node."""
    body = _get(client, max_nodes=2000)
    node_ids = {n["paper_id"] for n in body["nodes"]}
    connected = {e["citing_id"] for e in body["edges"]} | {e["cited_id"] for e in body["edges"]}
    assert node_ids == connected


def test_edge_direction_matches_the_citation_table(client, engine):
    body = _get(client, max_nodes=2000)
    node_ids = {n["paper_id"] for n in body["nodes"]}
    if not node_ids:
        pytest.skip("no connected papers in this seeded run")
    rows = q(
        engine,
        "SELECT Citing_Paper_ID, Cited_Paper_ID FROM CITATION "
        "WHERE Citing_Paper_ID = ANY(:ids) AND Cited_Paper_ID = ANY(:ids)",
        ids=list(node_ids),
    )
    expected = {(c, d) for c, d in rows}
    seen = {(e["citing_id"], e["cited_id"]) for e in body["edges"]}
    assert seen <= expected


def test_max_nodes_keeps_the_highest_in_set_degree(client):
    full = _get(client, max_nodes=2000)
    if len(full["nodes"]) < 3:
        pytest.skip("not enough connected papers in this seeded run to cap")
    degree: dict[int, int] = {}
    for e in full["edges"]:
        degree[e["citing_id"]] = degree.get(e["citing_id"], 0) + 1
        degree[e["cited_id"]] = degree.get(e["cited_id"], 0) + 1
    cap = max(1, len(full["nodes"]) - 1)
    capped = _get(client, max_nodes=cap)
    assert capped["truncated"] is True
    assert capped["total_candidates"] == full["total_candidates"]
    assert len(capped["nodes"]) <= cap
    expected_top = sorted(degree, key=lambda pid: degree[pid], reverse=True)[:cap]
    assert {n["paper_id"] for n in capped["nodes"]} == set(expected_top)


def test_year_filter_narrows_the_network(client):
    full = _get(client, max_nodes=2000)
    narrowed = _get(client, max_nodes=2000, year_from=2024)
    assert len(narrowed["nodes"]) <= len(full["nodes"])
    assert all(n["year"] >= 2024 for n in narrowed["nodes"])


def test_no_results_returns_an_empty_network_not_an_error(client):
    body = _get(client, q="zzz no such topic zzz")
    assert body == {
        "nodes": [], "edges": [], "total_candidates": 0, "truncated": False,
        "query": "zzz no such topic zzz",
        "search_meta": body["search_meta"],
    }
    assert body["search_meta"]["mongo"] in ("ok", "unavailable", "skipped")


def test_community_id_is_none_before_graph_communities_has_run(client, engine):
    if q(engine, "SELECT COUNT(*) FROM RESEARCH_COMMUNITY")[0][0] != 0:
        pytest.skip("an earlier test module already ran graph.communities in this session")
    body = _get(client, max_nodes=2000)
    assert body["nodes"] and all(n["community_id"] is None for n in body["nodes"])


@pytest.fixture(scope="module")
def communities_run(seeded, mongo):
    from graph.communities import detect_and_store
    from ingestion.extract_topics import extract_topics

    extract_topics()
    return detect_and_store()


def test_community_id_matches_the_authors_majority_once_communities_have_run(client, engine, communities_run):
    body = _get(client, max_nodes=2000)
    assigned = [n for n in body["nodes"] if n["community_id"] is not None]
    if not assigned:
        pytest.skip("no assigned-author papers among the connected nodes in this seeded run")
    for n in assigned:
        rows = q(
            engine,
            "SELECT cm.Community_ID FROM AUTHORSHIP au JOIN COMMUNITY_MEMBER cm "
            "ON cm.Author_ID = au.Author_ID WHERE au.Paper_ID = :pid",
            pid=n["paper_id"],
        )
        counts: dict[int, int] = {}
        for (cid,) in rows:
            counts[cid] = counts.get(cid, 0) + 1
        if not counts:
            continue
        best = max(counts.values())
        expected = min(cid for cid, c in counts.items() if c == best)
        assert n["community_id"] == expected


def test_venue_filter_narrows_the_network(client):
    unfiltered = _get(client, max_nodes=2000)
    sample = client.get("/search/papers", params={"q": "federated learning", "limit": 1}).json()["items"]
    if not sample or sample[0]["venue_id"] is None:
        pytest.skip("no venue on the top federated-learning paper in this seeded run")
    scoped = _get(client, max_nodes=2000, venue_id=sample[0]["venue_id"])
    assert len(scoped["nodes"]) <= len(unfiltered["nodes"])
