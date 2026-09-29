"""
M4 Part 3 -- unit tests for graph.influence_core. No database: every test
builds a small graph or community map by hand, same style as
test_community_core.py / test_trend_core.py.
"""
from __future__ import annotations

import math

import networkx as nx
import pytest

from graph.influence_core import (
    ALGORITHM_NAME,
    algorithm_label,
    betweenness_centrality,
    compute_influence,
    degree_centrality,
    pagerank_scores,
    participation_coefficients,
)


def test_algorithm_label_is_the_constant_name():
    assert algorithm_label() == ALGORITHM_NAME


# ============================================================
# Degree centrality
# ============================================================

def test_degree_centrality_is_unweighted_structural_degree():
    # Star graph: hub connects to 4 leaves with very different weights.
    # Degree centrality must ignore weight entirely -- the hub has 4
    # neighbours out of 4 possible (n - 1 = 4), leaves have 1.
    g = nx.Graph()
    for i, w in enumerate([100.0, 0.01, 5.0, 5.0], start=1):
        g.add_edge("hub", f"leaf{i}", weight=w)
    dc = degree_centrality(g)
    assert dc["hub"] == pytest.approx(1.0)
    assert all(dc[f"leaf{i}"] == pytest.approx(1 / 4) for i in range(1, 5))


def test_degree_centrality_isolated_node_is_zero():
    g = nx.Graph()
    g.add_node("lonely")
    g.add_edge("a", "b", weight=1.0)
    assert degree_centrality(g)["lonely"] == 0.0


def test_degree_centrality_empty_graph():
    assert degree_centrality(nx.Graph()) == {}


# ============================================================
# Betweenness centrality (weight -> distance inversion)
# ============================================================

def test_betweenness_prefers_the_strong_tie_path():
    # a - b - c is a strong (weight 10) path; a - d - c is weak (weight 0.5).
    # If weight were read as a distance directly (no inversion), the weak
    # path would look "shorter" and betweenness would land on d instead of b.
    g = nx.Graph()
    g.add_edge("a", "b", weight=10.0)
    g.add_edge("b", "c", weight=10.0)
    g.add_edge("a", "d", weight=0.5)
    g.add_edge("d", "c", weight=0.5)
    bc = betweenness_centrality(g)
    assert bc["b"] > bc["d"], "betweenness must treat higher weight as a closer (not farther) tie"


def test_betweenness_small_graphs_are_zero():
    assert betweenness_centrality(nx.Graph()) == {}
    g = nx.Graph()
    g.add_edge("a", "b", weight=1.0)
    assert betweenness_centrality(g) == {"a": 0.0, "b": 0.0}


def test_distance_graph_rejects_nonpositive_weight():
    from graph.influence_core import _distance_graph

    g = nx.Graph()
    g.add_edge("a", "b", weight=0.0)
    with pytest.raises(ValueError):
        _distance_graph(g)


# ============================================================
# PageRank
# ============================================================

def test_pagerank_rewards_the_more_strongly_tied_neighbor():
    g = nx.Graph()
    g.add_edge("hub", "strong", weight=10.0)
    g.add_edge("hub", "weak", weight=0.1)
    pr = pagerank_scores(g)
    assert pr["strong"] > pr["weak"]


def test_pagerank_edgeless_graph_is_uniform():
    g = nx.Graph()
    g.add_nodes_from(["a", "b", "c", "d"])
    pr = pagerank_scores(g)
    assert pr == {n: pytest.approx(0.25) for n in "abcd"}


def test_pagerank_empty_graph():
    assert pagerank_scores(nx.Graph()) == {}


# ============================================================
# Bridge score: participation coefficient
# ============================================================

def _star(center: str, leaves: dict[str, float]) -> nx.Graph:
    g = nx.Graph()
    for leaf, w in leaves.items():
        g.add_edge(center, leaf, weight=w)
    return g


def test_ties_entirely_within_one_community_score_zero():
    g = _star("x", {"a": 1.0, "b": 2.0, "c": 3.0})
    result = participation_coefficients(g, {"a": 1, "b": 1, "c": 1})["x"]
    assert result.bridge_score == 0.0
    assert result.communities_touched == 1


def test_no_ties_into_any_community_score_zero():
    g = _star("x", {"a": 1.0, "b": 1.0})
    # Neither neighbour is in author_community at all.
    result = participation_coefficients(g, {})["x"]
    assert result.bridge_score == 0.0
    assert result.communities_touched == 0
    assert result.ties == []


def test_evenly_split_two_communities_gives_point_five():
    g = _star("x", {"a": 1.0, "b": 1.0})
    result = participation_coefficients(g, {"a": 1, "b": 2})["x"]
    # P = 1 - (0.5^2 + 0.5^2) = 0.5
    assert result.bridge_score == pytest.approx(0.5)
    assert result.communities_touched == 2
    assert {t.community_id for t in result.ties} == {1, 2}


def test_evenly_split_three_communities_matches_guimera_amaral_formula():
    g = _star("x", {"a": 1.0, "b": 1.0, "c": 1.0})
    result = participation_coefficients(g, {"a": 1, "b": 2, "c": 3})["x"]
    expected = 1.0 - 3 * (1 / 3) ** 2
    assert result.bridge_score == pytest.approx(round(expected, 6))
    assert result.communities_touched == 3


def test_unevenly_split_scores_lower_than_even_split():
    even = _star("x", {"a": 1.0, "b": 1.0})
    uneven = _star("x", {"a": 9.0, "b": 1.0})
    r_even = participation_coefficients(even, {"a": 1, "b": 2})["x"]
    r_uneven = participation_coefficients(uneven, {"a": 1, "b": 2})["x"]
    assert r_uneven.bridge_score < r_even.bridge_score
    assert 0.0 < r_uneven.bridge_score


def test_ties_ignore_neighbours_outside_any_community_but_still_score():
    # x has one tie into a lone community and one tie to an unassigned author;
    # only the assigned tie counts toward the denominator, so with only one
    # *counted* community this still scores 0 (not skewed by the extra tie).
    g = _star("x", {"a": 5.0, "outsider": 100.0})
    result = participation_coefficients(g, {"a": 1})["x"]
    assert result.bridge_score == 0.0
    assert result.communities_touched == 1


def test_bridge_researcher_who_is_not_a_community_member_can_still_score():
    # "x" itself has no entry in author_community (Louvain left it
    # unassigned) but its neighbours span two communities -- exactly the
    # broker case the participation coefficient is meant to catch.
    g = _star("x", {"a": 1.0, "b": 1.0})
    author_community = {"a": 1, "b": 2}   # "x" deliberately absent
    result = participation_coefficients(g, author_community)["x"]
    assert result.communities_touched == 2
    assert result.bridge_score == pytest.approx(0.5)


def test_ties_are_sorted_by_weight_descending():
    g = _star("x", {"a": 1.0, "b": 9.0, "c": 5.0})
    result = participation_coefficients(g, {"a": 1, "b": 2, "c": 3})["x"]
    assert [t.community_id for t in result.ties] == [2, 3, 1]


# ============================================================
# Combine
# ============================================================

def test_compute_influence_covers_every_node_and_sorts_by_bridge_then_pagerank():
    g = nx.Graph()
    g.add_edge("bridge", "a", weight=1.0)
    g.add_edge("bridge", "b", weight=1.0)
    g.add_edge("a", "a2", weight=3.0)   # deepens a's community, doesn't touch bridge's score
    g.add_node("lonely")
    author_community = {"a": 1, "a2": 1, "b": 2}

    results = compute_influence(g, author_community)
    by_id = {r.author_id: r for r in results}

    assert set(by_id) == {"bridge", "a", "a2", "b", "lonely"}
    assert by_id["bridge"].communities_touched == 2
    assert by_id["bridge"].bridge_score == pytest.approx(0.5)
    assert by_id["lonely"].degree_centrality == 0.0
    assert by_id["lonely"].bridge_score == 0.0

    # bridge_score desc is the primary sort key -- "bridge" must lead.
    assert results[0].author_id == "bridge"
