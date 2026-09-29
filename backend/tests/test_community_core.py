"""
M4 Part 1 — unit tests for graph.community_core. No database: every test builds
a small graph or corpus by hand, so a failure points at the decision being
made (partitioning, scoring, labelling) and not at SQL.
"""
from __future__ import annotations

import itertools
import random

import networkx as nx

from graph.community_core import (
    DEFAULT_MIN_SIZE,
    LabelContext,
    algorithm_label,
    canonical_graph,
    detect_communities,
    display_name,
    label_community,
    membership_scores,
)


def _cliques(*sizes: int, start: int = 1, weight: float = 3.0, bridge: float | None = 0.5) -> tuple[nx.Graph, list[set[int]]]:
    """Disjoint weighted cliques, optionally chained by one weak bridge edge each."""
    g = nx.Graph()
    groups: list[set[int]] = []
    nxt = start
    for size in sizes:
        members = list(range(nxt, nxt + size))
        nxt += size + 10          # gap so ids never collide with the next group
        groups.append(set(members))
        for u, v in itertools.combinations(members, 2):
            g.add_edge(u, v, weight=weight)
    if bridge is not None:
        for left, right in zip(groups, groups[1:]):
            g.add_edge(min(left), min(right), weight=bridge)
    return g, groups


def _raises(exc: type[Exception], fn, *args, **kwargs) -> bool:
    try:
        fn(*args, **kwargs)
    except exc:
        return True
    return False


# ============================================================
# Detection
# ============================================================

def test_recovers_two_planted_communities():
    g, (a, b) = _cliques(8, 8)
    part = detect_communities(g)
    assert {frozenset(c) for c in part.communities} == {frozenset(a), frozenset(b)}
    assert part.unassigned == 0
    assert part.modularity > 0.3


def _noisy_planted(seed: int, n: int = 60, k: int = 4, p_in: float = 0.5, p_out: float = 0.12) -> nx.Graph:
    """Planted partition with random weights and cross-community noise. Unlike
    clean cliques, Louvain's result on this depends on the order it visits
    nodes, so it can actually catch a missing canonical ordering."""
    rng = random.Random(seed)
    g = nx.Graph()
    for u in range(1, n + 1):
        for v in range(u + 1, n + 1):
            if rng.random() < (p_in if u % k == v % k else p_out):
                g.add_edge(u, v, weight=round(rng.uniform(0.5, 4.0), 2))
    return g


def test_result_is_independent_of_graph_construction_order():
    for graph_seed in range(3):
        g = _noisy_planted(graph_seed)
        baseline = detect_communities(g).communities
        for trial in range(5):
            rng = random.Random(trial)
            nodes, edges = list(g.nodes), list(g.edges(data=True))
            rng.shuffle(nodes)
            rng.shuffle(edges)
            h = nx.Graph()
            h.add_nodes_from(nodes)
            for u, v, d in edges:
                (h.add_edge(v, u, **d) if rng.random() < 0.5 else h.add_edge(u, v, **d))
            assert detect_communities(h).communities == baseline, (graph_seed, trial)


def test_same_inputs_and_seed_give_same_partition():
    g, _ = _cliques(6, 6, 6, 6)
    assert detect_communities(g, seed=7).communities == detect_communities(g, seed=7).communities


def test_isolates_and_undersized_components_are_not_assigned():
    g, (clique,) = _cliques(6, bridge=None)
    g.add_edge(200, 201, weight=3.0)          # a lone pair: a collaboration, not a community
    g.add_node(300)                           # an isolated author
    part = detect_communities(g)              # DEFAULT_MIN_SIZE
    assert DEFAULT_MIN_SIZE == 3
    assert [set(c) for c in part.communities] == [clique]
    assert part.found == 2                    # the clique and the pair; the isolate never reaches Louvain
    assert part.unassigned == 3               # 200, 201, 300

    with_pairs = detect_communities(g, min_size=2)
    assert {frozenset(c) for c in with_pairs.communities} == {frozenset(clique), frozenset({200, 201})}
    assert with_pairs.unassigned == 1


def test_graph_without_edges_yields_no_communities():
    g = nx.Graph()
    g.add_nodes_from([1, 2, 3])
    part = detect_communities(g)
    assert part.communities == [] and part.modularity == 0.0 and part.found == 0 and part.unassigned == 3
    assert detect_communities(nx.Graph()).communities == []


def test_communities_are_ordered_by_size_then_smallest_author():
    g, (small, big) = _cliques(5, 8, bridge=None)
    order = [set(c) for c in detect_communities(g).communities]
    assert order == [big, small]

    g2, (first, second) = _cliques(6, 6, bridge=None)        # equal sizes: lowest id first
    assert [set(c) for c in detect_communities(g2).communities] == [first, second]


def test_lower_resolution_merges_and_higher_resolution_splits():
    # Four cliques joined in a ring by moderately strong bridges.
    g, groups = _cliques(6, 6, 6, 6, bridge=None)
    for left, right in zip(groups, groups[1:] + groups[:1]):
        g.add_edge(min(left), min(right), weight=4.0)
    coarse = detect_communities(g, resolution=0.05)
    fine = detect_communities(g, resolution=2.0)
    assert len(coarse.communities) < len(fine.communities)
    assert len(fine.communities) >= 4


def test_canonical_graph_drops_isolates_and_keeps_only_weight():
    g = nx.Graph()
    g.add_node(9)
    g.add_edge(2, 1, weight=2.5, coauthor_weight=2.5, note="x")
    h = canonical_graph(g)
    assert list(h.nodes) == [1, 2]
    assert dict(h[1][2]) == {"weight": 2.5}


def test_invalid_parameters_are_rejected():
    g, _ = _cliques(5, 5)
    assert _raises(ValueError, detect_communities, g, resolution=0)
    assert _raises(ValueError, detect_communities, g, resolution=-1.0)
    assert _raises(ValueError, detect_communities, g, min_size=0)
    assert _raises(ValueError, detect_communities, g, seed=-1)
    assert _raises(ValueError, detect_communities, g, seed=2**32)
    assert _raises(ValueError, detect_communities, g, seed=1.5)


def test_algorithm_label_records_parameters_and_fits_the_column():
    assert algorithm_label(1.0, 42) == "louvain(resolution=1,seed=42)"
    assert "resolution=0.5" in algorithm_label(0.5, 1)
    worst = algorithm_label(1.234567891e-05, 2**32 - 1)
    assert len(worst) <= 50                    # RESEARCH_COMMUNITY.Algorithm is VARCHAR(50)
    assert len(algorithm_label(123456.789, 2**32 - 1)) <= 50


# ============================================================
# Membership score
# ============================================================

def test_membership_score_is_share_of_tie_weight_inside_the_community():
    g, (a, b) = _cliques(6, 6, bridge=1.0)
    scores = membership_scores(g, a)
    anchor = min(a)                            # the one member with a tie outside
    assert scores[anchor] == round(15.0 / 16.0, 4)     # 5 internal ties x 3.0, plus a 1.0 bridge
    assert all(scores[m] == 1.0 for m in a if m != anchor)
    assert all(0.0 <= s <= 1.0 for s in scores.values())


def test_membership_score_of_a_member_with_no_ties_is_zero():
    g = nx.Graph()
    g.add_node(1)
    g.add_edge(2, 3, weight=1.0)
    assert membership_scores(g, {1, 2, 3}) == {1: 0.0, 2: 1.0, 3: 1.0}


# ============================================================
# Labels
# ============================================================

FL, PRIVACY, HEALTH, NOISE = 10, 11, 12, 13
NAMES = {FL: "federated learning", PRIVACY: "privacy", HEALTH: "healthcare", NOISE: "misc"}
X, Y = frozenset({1, 2, 3}), frozenset({4, 5, 6})


def _corpus(extra_cross_papers: int = 0) -> LabelContext:
    """Papers 1-5 by community X (privacy), 6-10 by community Y (healthcare),
    every paper tagged with the corpus-wide 'federated learning'. Optionally
    some papers written by 1 X author and 3 Y authors, tagged healthcare."""
    authors, topics = {}, {}
    for p in range(1, 6):
        authors[p], topics[p] = {1 + p % 3, 1 + (p + 1) % 3}, {FL, PRIVACY}
    for p in range(6, 11):
        authors[p], topics[p] = {4 + p % 3, 4 + (p + 1) % 3}, {FL, HEALTH}
    for i in range(extra_cross_papers):
        p = 100 + i
        authors[p], topics[p] = {1, 4, 5, 6}, {FL, HEALTH}
    return LabelContext.build(authors, topics, NAMES)


def test_label_is_root_topic_plus_most_distinctive_topic():
    ctx = _corpus()
    x, y = label_community(X, 1, ctx), label_community(Y, 2, ctx)
    assert x.label == "Federated Learning + Privacy" and x.root_topic_id == FL
    assert y.label == "Federated Learning + Healthcare" and y.root_topic_id == FL


def test_corpus_wide_topic_scores_zero_and_is_never_the_distinctive_term():
    ctx = _corpus()
    x = label_community(X, 1, ctx)
    fl = next(e for e in x.evidence if e.topic_id == FL)
    privacy = next(e for e in x.evidence if e.topic_id == PRIVACY)
    assert fl.share == 1.0 and fl.corpus_share == 1.0 and fl.score == 0.0
    assert privacy.score > 0
    assert x.evidence[0].topic_id == FL                       # root first
    assert "Federated Learning + Federated Learning" not in x.label


def test_papers_mostly_written_by_outsiders_do_not_stamp_their_topics_on_a_community():
    # 3 papers with 1 X author and 3 Y authors, tagged healthcare. Counted whole
    # they would give X a 3/8 = 37% healthcare share and a "Healthcare" label
    # term; weighted by X's 25% of each paper it is 3*0.25 / 5.75 = 13%.
    ctx = _corpus(extra_cross_papers=3)
    x = label_community(X, 1, ctx)
    assert HEALTH not in {e.topic_id for e in x.evidence}
    assert x.label == "Federated Learning + Privacy"
    y = label_community(Y, 2, ctx)
    assert y.label == "Federated Learning + Healthcare"


def test_community_without_topics_gets_a_rank_based_fallback_label():
    ctx = LabelContext.build({1: {1, 2, 3}, 2: {2, 3}}, {}, {})
    lab = label_community(frozenset({1, 2, 3}), 4, ctx)
    assert lab.label == "Community 4" and lab.root_topic_id is None and lab.evidence == []


def test_topics_below_the_share_floor_are_not_label_candidates():
    authors = {p: {1, 2, 3} for p in range(1, 11)}
    topics = {p: {FL} for p in authors}
    topics[1].add(NOISE)                                    # 1 of 10 papers = 10% < 20%
    ctx = LabelContext.build(authors, topics, NAMES)
    lab = label_community(frozenset({1, 2, 3}), 1, ctx)
    assert NOISE not in {e.topic_id for e in lab.evidence}
    assert lab.label == "Federated Learning"                 # nothing distinctive: root alone


def test_label_is_deterministic_when_topics_tie():
    authors = {p: {1, 2, 3} for p in range(1, 5)}
    topics = {p: {FL, PRIVACY, HEALTH} for p in authors}     # PRIVACY and HEALTH tie exactly
    authors.update({p: {7, 8} for p in range(5, 9)})          # other papers, so neither is corpus-wide
    topics.update({p: {FL} for p in range(5, 9)})
    labels = {label_community(frozenset({1, 2, 3}), 1, LabelContext.build(authors, topics, NAMES)).label for _ in range(5)}
    assert labels == {"Federated Learning + Healthcare"}     # tie broken by name


def test_label_context_ignores_papers_without_authors():
    ctx = LabelContext.build({1: {1, 2}, 2: set()}, {1: {FL}, 2: {FL, PRIVACY}}, NAMES)
    assert set(ctx.paper_authors) == {1}
    assert ctx.corpus_share == {FL: 1.0}


def test_display_name_titlecases_only_lowercase_names():
    assert display_name("differential privacy") == "Differential Privacy"
    assert display_name("BERT models") == "BERT models"
