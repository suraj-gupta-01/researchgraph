"""
G5 -- the institution collaboration network (/institutions/network), against
a real PostgreSQL. derive_collaboration itself is exercised by the `seeded`
fixture; this file is about what the endpoint does with COLLABORATION: edge
aggregation to distinct shared papers, min_shared, the limit cap, and ego
mode (center_id).

Runs on the synthetic dev corpus, same as test_api.py.
"""
from __future__ import annotations

import pytest

from tests.conftest import q


def _get(client, **params):
    r = client.get("/institutions/network", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _pairs(engine) -> dict[tuple[int, int], int]:
    rows = q(
        engine,
        "SELECT Institution_A_ID, Institution_B_ID, COUNT(DISTINCT Paper_ID) "
        "FROM COLLABORATION GROUP BY Institution_A_ID, Institution_B_ID",
    )
    return {(a, b): n for a, b, n in rows}


def test_edges_match_the_collaboration_table(client, engine):
    pairs = _pairs(engine)
    assert pairs, "the seeded corpus has multi-institution papers"
    body = _get(client, limit=500)
    assert body["truncated"] is False
    seen = {(e["source"], e["target"]): e["shared_papers"] for e in body["edges"]}
    assert seen == pairs
    for s, t in seen:
        assert s < t, "edges keep COLLABORATION's canonical (low id, high id) order"


def test_nodes_are_exactly_the_connected_institutions(client):
    body = _get(client, limit=500)
    node_ids = {n["institution_id"] for n in body["nodes"]}
    connected = {e["source"] for e in body["edges"]} | {e["target"] for e in body["edges"]}
    assert node_ids == connected
    assert body["total_candidates"] == len(node_ids)


def test_node_degree_fields_describe_the_drawn_graph(client):
    body = _get(client, limit=500)
    for n in body["nodes"]:
        mine = [e for e in body["edges"] if n["institution_id"] in (e["source"], e["target"])]
        assert n["collaborators"] == len(mine)
        assert n["shared_papers"] == sum(e["shared_papers"] for e in mine)
        assert n["paper_count"] >= 1


def test_min_shared_drops_weak_pairs(client, engine):
    pairs = _pairs(engine)
    threshold = max(pairs.values())
    body = _get(client, limit=500, min_shared=threshold)
    assert body["min_shared"] == threshold
    assert body["edges"] and all(e["shared_papers"] >= threshold for e in body["edges"])
    assert len(body["edges"]) == sum(1 for n in pairs.values() if n >= threshold)


def test_limit_keeps_the_highest_weighted_degree(client):
    full = _get(client, limit=500)
    if len(full["nodes"]) < 3:
        pytest.skip("not enough connected institutions in this seeded run to cap")
    strength = {n["institution_id"]: n["shared_papers"] for n in full["nodes"]}
    cap = len(full["nodes"]) - 1
    capped = _get(client, limit=cap)
    assert capped["truncated"] is True
    assert capped["total_candidates"] == full["total_candidates"]
    assert len(capped["nodes"]) == cap
    kept = {n["institution_id"] for n in capped["nodes"]}
    dropped = set(strength) - kept
    assert min(strength[i] for i in kept) >= max(strength[i] for i in dropped)
    for e in capped["edges"]:
        assert e["source"] in kept and e["target"] in kept


def test_ego_mode_is_the_centre_and_its_partners(client, engine):
    pairs = _pairs(engine)
    centre = max({a for a, _ in pairs} | {b for _, b in pairs}, key=lambda i: sum(
        1 for p in pairs if i in p))
    partners = {b if a == centre else a for a, b in pairs if centre in (a, b)}
    body = _get(client, center_id=centre, limit=500)
    assert body["center_id"] == centre
    assert body["nodes"][0]["institution_id"] == centre
    assert {n["institution_id"] for n in body["nodes"]} == {centre} | partners
    members = {centre} | partners
    expected_edges = {p for p in pairs if p[0] in members and p[1] in members}
    assert {(e["source"], e["target"]) for e in body["edges"]} == expected_edges


def test_ego_mode_agrees_with_the_collaborators_endpoint(client, engine):
    pairs = _pairs(engine)
    centre = next(iter(pairs))[0]
    ego = _get(client, center_id=centre, limit=500)
    collab = client.get(f"/institutions/{centre}/collaborators", params={"limit": 100}).json()
    ego_weights = {
        (e["target"] if e["source"] == centre else e["source"]): e["shared_papers"]
        for e in ego["edges"] if centre in (e["source"], e["target"])
    }
    assert ego_weights == {c["institution_id"]: c["shared_papers"] for c in collab["items"]}


def test_ego_mode_cap_always_keeps_the_centre(client, engine):
    pairs = _pairs(engine)
    centre = next(iter(pairs))[0]
    body = _get(client, center_id=centre, limit=2)
    assert body["nodes"][0]["institution_id"] == centre
    assert len(body["nodes"]) <= 2


def test_ego_mode_for_an_institution_without_partners(client, engine):
    lonely = q(
        engine,
        "SELECT Institution_ID FROM INSTITUTION i WHERE NOT EXISTS ("
        " SELECT 1 FROM COLLABORATION c WHERE i.Institution_ID IN (c.Institution_A_ID, c.Institution_B_ID)) LIMIT 1",
    )
    if not lonely:
        pytest.skip("every seeded institution collaborates")
    body = _get(client, center_id=lonely[0][0])
    assert [n["institution_id"] for n in body["nodes"]] == [lonely[0][0]]
    assert body["edges"] == [] and body["nodes"][0]["collaborators"] == 0


def test_unknown_centre_is_404(client):
    assert client.get("/institutions/network", params={"center_id": 2_000_000_000}).status_code == 404


@pytest.mark.parametrize("params", [{"limit": 1}, {"limit": 501}, {"min_shared": 0}, {"center_id": 0}])
def test_invalid_parameters_are_422(client, params):
    assert client.get("/institutions/network", params=params).status_code == 422


def test_network_route_is_not_swallowed_by_the_detail_route(client):
    """/institutions/{id} is int-typed; /network must be declared first or
    every call 422s."""
    assert client.get("/institutions/network").status_code == 200


# ============================================================
# /institutions/countries -- the Top institutions view's country breakdown
# ============================================================

def test_country_breakdown_matches_the_institution_table(client, engine):
    body = client.get("/institutions/countries", params={"limit": 300}).json()
    expected = dict(q(engine, "SELECT Country, COUNT(*) FROM INSTITUTION GROUP BY Country"))
    assert {i["country"]: i["institution_count"] for i in body["items"]} == expected
    assert body["total_institutions"] == sum(expected.values())


def test_country_paper_counts_are_distinct_per_country(client, engine):
    body = client.get("/institutions/countries", params={"limit": 300}).json()
    for item in body["items"]:
        if item["country"] is None:
            continue
        n = q(
            engine,
            "SELECT COUNT(DISTINCT vi.Paper_ID) FROM v_paper_institution vi "
            "JOIN INSTITUTION i ON i.Institution_ID = vi.Institution_ID WHERE i.Country = :c",
            c=item["country"],
        )[0][0]
        assert item["paper_count"] == n
    papers = [i["paper_count"] for i in body["items"]]
    assert papers == sorted(papers, reverse=True)
    assert body["total_papers"] <= sum(papers)


def test_country_breakdown_limit(client):
    body = client.get("/institutions/countries", params={"limit": 1}).json()
    assert len(body["items"]) == 1
    assert client.get("/institutions/countries", params={"limit": 0}).status_code == 422
