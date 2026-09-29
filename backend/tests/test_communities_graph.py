"""
G1 -- the community graph endpoint (/communities/graph), against a real
PostgreSQL. The collaboration-graph builder itself (edge signals, weights)
is already covered in test_build_graph.py; this file is about what the
endpoint does with it -- topic scoping, the min_weight/max_nodes controls,
and how it degrades before graph.communities / graph.influence have run.

Runs on the synthetic dev corpus, same as test_communities.py.
"""
from __future__ import annotations

import pytest

from tests.conftest import q


def _get(client, **params):
    r = client.get("/communities/graph", params=params)
    assert r.status_code == 200, r.text
    return r.json()


# ============================================================
# Before graph.communities / graph.influence have run
# ============================================================

def test_graph_exists_before_any_analysis_has_run(client, engine, seeded):
    """The collaboration graph itself needs no prior job; only the per-node
    labels do."""
    if q(engine, "SELECT COUNT(*) FROM RESEARCH_COMMUNITY")[0][0] != 0:
        pytest.skip("an earlier test module already ran graph.communities in this session")
    body = _get(client)
    assert body["nodes"], "the seeded corpus has coauthors; the graph should not be empty"
    assert body["algorithm"] is None and body["detection_date"] is None
    assert all(n["community_id"] is None and n["membership_score"] is None for n in body["nodes"])
    assert all(n["bridge_score"] is None and n["communities_touched"] is None for n in body["nodes"])


# ============================================================
# After graph.communities and graph.influence have run
# ============================================================

@pytest.fixture(scope="module")
def run(seeded, mongo):
    from graph.communities import detect_and_store as detect_communities
    from graph.influence import detect_and_store as detect_influence
    from ingestion.extract_topics import extract_topics

    extract_topics()
    communities = detect_communities()
    influence = detect_influence()
    return {"communities": communities, "influence": influence}


def test_node_community_matches_community_member_table(client, engine, run):
    rows = q(engine, "SELECT Author_ID, Community_ID, Membership_Score FROM COMMUNITY_MEMBER")
    expected = {aid: (cid, float(score)) for aid, cid, score in rows}
    body = _get(client, max_nodes=2000)
    seen = {n["author_id"]: (n["community_id"], n["membership_score"]) for n in body["nodes"] if n["community_id"] is not None}
    # Every assigned author who also has >= 1 qualifying edge must agree with COMMUNITY_MEMBER exactly.
    for aid, (cid, score) in seen.items():
        assert expected[aid][0] == cid
        assert expected[aid][1] == pytest.approx(score)


def test_algorithm_and_detection_date_match_the_stored_run(client, engine, run):
    algo, _ts = q(engine, "SELECT DISTINCT Algorithm, Detection_Date FROM RESEARCH_COMMUNITY")[0]
    body = _get(client)
    assert body["algorithm"] == algo


def test_bridge_researchers_carry_influence_fields(client, engine, run):
    bridge_ids = {aid for (aid,) in q(engine, "SELECT Author_ID FROM AUTHOR_INFLUENCE WHERE Communities_Touched >= 2")}
    if not bridge_ids:
        pytest.skip("no bridge researchers in this seeded run")
    body = _get(client, max_nodes=2000)
    by_id = {n["author_id"]: n for n in body["nodes"]}
    for aid in bridge_ids:
        if aid in by_id:  # only if it also survived the isolated-author filter
            assert by_id[aid]["communities_touched"] is not None
            assert by_id[aid]["bridge_score"] is not None


# ============================================================
# Edges and their signal breakdown
# ============================================================

def test_edge_signals_sum_to_the_edge_weight(client, seeded):
    body = _get(client, max_nodes=2000)
    assert body["edges"]
    for e in body["edges"]:
        total = sum(e["signals"].values())
        assert total == pytest.approx(e["weight"], abs=1e-6)
        assert e["source"] != e["target"]


def test_edges_are_undirected_no_duplicate_pairs(client, seeded):
    body = _get(client, max_nodes=2000)
    seen = set()
    for e in body["edges"]:
        key = (min(e["source"], e["target"]), max(e["source"], e["target"]))
        assert key not in seen, "each author pair should appear as exactly one edge"
        seen.add(key)


# ============================================================
# min_weight and max_nodes controls
# ============================================================

def test_min_weight_only_removes_edges_below_the_floor(client, seeded):
    base = _get(client, max_nodes=2000)
    floor = 1.0
    filtered = _get(client, max_nodes=2000, min_weight=floor)
    assert all(e["weight"] >= floor for e in filtered["edges"])
    assert len(filtered["edges"]) <= len(base["edges"])


def test_isolated_authors_are_left_out_not_zero_degree_nodes(client, seeded):
    body = _get(client, max_nodes=2000)
    node_ids = {n["author_id"] for n in body["nodes"]}
    touched = {e["source"] for e in body["edges"]} | {e["target"] for e in body["edges"]}
    assert node_ids == touched, "every returned node should be an endpoint of at least one returned edge"


def test_max_nodes_caps_by_weighted_degree_and_reports_truncated(client, seeded):
    full = _get(client, max_nodes=2000)
    total = full["total_candidates"]
    if total < 3:
        pytest.skip("not enough connected authors in this corpus to test truncation")
    small = _get(client, max_nodes=total - 1)
    assert small["truncated"] is True
    assert len(small["nodes"]) == total - 1
    assert full["truncated"] is False

    def weighted_degree(body, author_id):
        return sum(e["weight"] for e in body["edges"] if author_id in (e["source"], e["target"]))

    full_degrees = {n["author_id"]: weighted_degree(full, n["author_id"]) for n in full["nodes"]}
    kept = {n["author_id"] for n in small["nodes"]}
    dropped = set(full_degrees) - kept
    assert dropped, "at least one author should have been cut"
    assert min(full_degrees[a] for a in kept) >= max(full_degrees[a] for a in dropped) - 1e-9


# ============================================================
# Topic scoping (?q=)
# ============================================================

def test_q_restricts_to_authors_of_matching_papers(client, engine, seeded):
    q_str = "federated learning"
    scoped = _get(client, q=q_str, max_nodes=2000)
    assert scoped["query"] == q_str
    assert scoped["search_meta"] is not None

    # Scoping reuses F1 search (title, topic and abstract channels), not a
    # title-only match, so the allowed authors come from /search/papers.
    paper_ids: set[int] = set()
    offset = 0
    while True:
        page = client.get("/search/papers", params={"q": q_str, "limit": 100, "offset": offset}).json()
        paper_ids |= {i["paper_id"] for i in page["items"]}
        offset += 100
        if offset >= page["total"]:
            break
    if not paper_ids:
        pytest.skip("no matching papers in this seeded corpus for this query")
    allowed = {aid for (aid,) in q(engine, "SELECT Author_ID FROM AUTHORSHIP WHERE Paper_ID = ANY(:ids)", ids=list(paper_ids))}
    for n in scoped["nodes"]:
        assert n["author_id"] in allowed


def test_q_with_no_matches_returns_an_empty_not_an_error(client):
    body = _get(client, q="a topic that does not exist anywhere in this corpus zzz")
    assert body["nodes"] == [] and body["edges"] == []
    assert body["total_candidates"] == 0 and body["truncated"] is False


# ============================================================
# Validation
# ============================================================

def test_out_of_range_params_are_422(client):
    assert client.get("/communities/graph", params={"max_nodes": 0}).status_code == 422
    assert client.get("/communities/graph", params={"max_nodes": 2001}).status_code == 422
    assert client.get("/communities/graph", params={"min_weight": -1}).status_code == 422


def test_graph_route_is_not_shadowed_by_the_community_id_route(client):
    # A regression guard: /communities/graph must be registered before
    # /communities/{community_id}, or "graph" gets parsed as an id and 422s.
    assert client.get("/communities/graph").status_code == 200
