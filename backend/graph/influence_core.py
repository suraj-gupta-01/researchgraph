"""
M4 -- Part 3 (F4): the pure half of researcher influence & bridge detection.

Same split as Parts 1 and 2 (graph.community_core / graph.trend_core):
everything here is a plain function over a NetworkX graph and plain Python
values -- no Postgres, no MongoDB -- so each metric can be unit-tested on a
small hand-built graph, and the PRD's F4 requirement ("compute degree
centrality, betweenness centrality, PageRank, and a community-bridge score
per author... documented") has one place to point an evaluator at.
`graph.influence` owns the I/O (read the collaboration graph and
COMMUNITY_MEMBER, write AUTHOR_INFLUENCE / AUTHOR_COMMUNITY_TIE, snapshot to
Mongo); this module owns the four metrics.

Runs on `graph.build_graph.build_author_collaboration_graph()` -- the same
weighted Author-Author graph Part 1's Louvain run partitions -- not the full
heterogeneous graph, so "degree"/"betweenness"/"PageRank" mean the same thing
here as "the graph community detection ran on", and a bridge score computed
against RESEARCH_COMMUNITY is asking the natural follow-on question: given
that partition, who sits between the parts it found?

------------------------------------------------------------------
The four metrics
------------------------------------------------------------------
1. Degree centrality (`degree_centrality`) -- standard NetworkX definition:
   an author's number of distinct collaborators, divided by (n - 1). Plain
   structural degree, not the edge-weighted "strength" -- the PRD names
   "degree centrality" without qualification, which is the textbook
   unweighted metric; a weighted variant would be a different, undocumented
   number under the same name. An isolated author (no ties at all) scores 0.

2. Betweenness centrality (`betweenness_centrality`) -- how often an author
   sits on the shortest path between two others, normalized to [0, 1]. This
   graph's edge weight is a *strength* (higher = closer), but NetworkX's
   shortest-path algorithms read `weight` as a *distance* (higher = further).
   Passed through unmodified, a strong tie would look like a long detour and
   betweenness would reward exactly the wrong paths. So betweenness is
   computed on a distance-transformed copy of the graph (`distance = 1 /
   weight` -- see `_distance_graph`) rather than the graph's own weights
   directly; this is the standard fix for the well-known
   strength-vs-distance mismatch (see e.g. Newman, "Analysis of weighted
   networks", 2004; Opsahl et al., 2010 discuss the alternative -- unused
   here to keep one betweenness definition rather than a tunable second
   parameter).

3. PageRank (`pagerank_scores`) -- NetworkX's weighted PageRank, `weight`
   used as-is: unlike betweenness, PageRank's damping-and-transfer model
   already reads a larger weight as "more importance flows along this edge",
   which is the same direction this graph's weight already points in, so no
   transform is needed here.

4. Bridge score (`participation_coefficients`) -- the **participation
   coefficient** (Guimera & Amaral, "Functional cartography of complex
   metabolic networks", Nature 2005), a standard, published, non-arbitrary
   measure of exactly what F4 asks for ("connecting >= 2 distinct
   communities"):

       P_i = 1 - sum_c ( k_ic / k_i )^2

   where `k_ic` is author i's total tie weight into community c's members
   and `k_i` is the author's total tie weight into ANY community's members
   (ties to authors outside every community are excluded from both sums --
   there is no third community for them to count toward). P_i is 0 when
   every tie lands in a single community (or the author has no ties into any
   community at all) and approaches 1 the more evenly ties are spread across
   many communities -- i.e. exactly "connects >= 2 distinct communities",
   with the spread, not just the count, driving the score. An author does
   not need to be a COMMUNITY_MEMBER themselves to get a bridge score: an
   author Louvain left unassigned (isolated, or in a too-small community,
   see community_core.DEFAULT_MIN_SIZE) whose neighbours span two
   communities is exactly the kind of broker this metric is meant to catch.

All four are independent of each other by design (the PRD lists them as
four separate outputs, not one blended score); `graph.influence` stores all
four per author rather than collapsing them into a single ranking.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field

import networkx as nx

ALGORITHM_NAME = "centrality+participation"

# Below this weight, "1 / weight" as a distance would blow up; no edge this
# graph builds should ever be this small (see build_graph.WEIGHT_* --
# smallest signal weight is 0.5), but zero-weight self-loops or a
# hand-built test graph could reach it, and a division by (near) zero should
# fail loudly in a unit test rather than silently produce inf.
_MIN_WEIGHT = 1e-9


def algorithm_label() -> str:
    """e.g. 'centrality+participation'. Stored on every AUTHOR_INFLUENCE row
    this module writes, so a `graph.influence.detect_and_store` run --
    unlike Parts 1/2, which expose tunable parameters -- can still be
    identified by name if a future part changes the formula (PRD Section 8,
    auditability). No parameters are exposed here: unlike Louvain's
    resolution or F3's growth thresholds, none of the four metrics below
    have a free parameter to record."""
    return ALGORITHM_NAME


def _distance_graph(g: nx.Graph) -> nx.Graph:
    """A copy of `g` with `distance = 1 / weight` on every edge, for
    algorithms (betweenness) that read `weight` as a cost to minimize rather
    than a strength to maximize. Raises ValueError on a non-positive weight
    rather than producing inf/NaN silently -- `build_author_collaboration_graph`
    never creates one, so seeing one here means the caller passed something
    else in."""
    h = nx.Graph()
    h.add_nodes_from(g.nodes())
    for u, v, d in g.edges(data=True):
        w = float(d.get("weight", 1.0))
        if w < _MIN_WEIGHT:
            raise ValueError(f"edge ({u!r}, {v!r}) has non-positive weight {w!r}; cannot invert to a distance")
        h.add_edge(u, v, distance=1.0 / w)
    return h


# ============================================================
# 1-3. Centrality metrics
# ============================================================

def degree_centrality(g: nx.Graph) -> dict[int, float]:
    """Unweighted structural degree centrality, NetworkX's own definition
    (degree / (n - 1)). A graph of 0 or 1 nodes has no valid denominator;
    NetworkX itself returns 0.0 for every node in that case rather than
    raising, which is preserved here."""
    if g.number_of_nodes() == 0:
        return {}
    return {n: round(float(v), 6) for n, v in nx.degree_centrality(g).items()}


def betweenness_centrality(g: nx.Graph) -> dict[int, float]:
    """Weighted betweenness on the distance-transformed graph (see module
    docstring). Exact (not the `k`-sampled approximation) -- fine at the
    class-project scale this system targets (PRD Section 11); a larger
    corpus would want `k=` sampling, at the cost of the result no longer
    being exactly reproducible run to run even with a fixed graph."""
    if g.number_of_nodes() < 3:
        # Betweenness needs at least one other node to sit *between*, so
        # every node scores 0 by definition rather than by an edge case in
        # the algorithm; nx.betweenness_centrality already returns this, but
        # the empty/singleton graph short-circuit avoids building a distance
        # graph (and its division-by-weight checks) for nothing.
        return {n: 0.0 for n in g.nodes()}
    h = _distance_graph(g)
    return {n: round(float(v), 6) for n, v in nx.betweenness_centrality(h, weight="distance", normalized=True).items()}


def pagerank_scores(g: nx.Graph) -> dict[int, float]:
    """Weighted PageRank; weight used as-is (see module docstring). Falls
    back to a uniform 1/n for an edgeless graph -- NetworkX's own behaviour,
    since PageRank's transfer model has nothing to propagate along."""
    if g.number_of_nodes() == 0:
        return {}
    if g.number_of_edges() == 0:
        n = g.number_of_nodes()
        return {node: round(1.0 / n, 8) for node in g.nodes()}
    return {n: round(float(v), 8) for n, v in nx.pagerank(g, weight="weight").items()}


# ============================================================
# 4. Bridge score: participation coefficient
# ============================================================

@dataclass(frozen=True)
class CommunityTie:
    community_id: int
    weight: float     # this author's total tie weight into that community's members
    share: float       # weight / this author's total tie weight into ANY community


@dataclass(frozen=True)
class BridgeResult:
    bridge_score: float                  # participation coefficient, 0..1 (see module docstring)
    communities_touched: int             # len(ties) -- distinct communities this author has >= 1 tie into
    ties: list[CommunityTie] = field(default_factory=list)   # sorted by weight desc, for evidence/display


_NO_TIES = BridgeResult(bridge_score=0.0, communities_touched=0, ties=[])


def participation_coefficients(
    g: nx.Graph, author_community: Mapping[int, int]
) -> dict[int, BridgeResult]:
    """Guimera & Amaral's participation coefficient for every node in `g`
    (see module docstring for the formula). `author_community` maps
    Author_ID -> Community_ID for authors RESEARCH_COMMUNITY/COMMUNITY_MEMBER
    currently assigns to a community (Part 1's output) -- an author absent
    from this mapping (unassigned, e.g. too small a community or isolated in
    the collaboration graph) can still receive ties *from* others and can
    still bridge, they just are not themselves a tie destination.

    A node with NO ties into any community gets `_NO_TIES` (score 0,
    `communities_touched` 0, no evidence) -- there is nothing to sum. A node
    with ties into exactly 1 community is not special-cased: the formula
    itself already gives P_i = 1 - (k_i/k_i)^2 = 0 for that case, so it falls
    out of the same computation naturally, but with `communities_touched`
    correctly reported as 1 (not 0) and its one tie kept as evidence -- the
    two are told apart by `communities_touched`, not by `bridge_score` alone,
    since 0.0 alone can't distinguish "touches nothing" from "deeply
    embedded in exactly one community". The PRD's own bar ("connecting >= 2
    distinct communities") is a threshold on `communities_touched`, not on
    `bridge_score`."""
    out: dict[int, BridgeResult] = {}
    for node in g.nodes():
        weight_by_community: dict[int, float] = defaultdict(float)
        for nbr, data in g[node].items():
            cid = author_community.get(nbr)
            if cid is None:
                continue
            weight_by_community[cid] += float(data.get("weight", 1.0))

        if not weight_by_community:
            out[node] = _NO_TIES
            continue

        total = sum(weight_by_community.values())
        score = 1.0 - sum((w / total) ** 2 for w in weight_by_community.values())
        ties = sorted(
            (CommunityTie(cid, round(w, 4), round(w / total, 5)) for cid, w in weight_by_community.items()),
            key=lambda t: (-t.weight, t.community_id),
        )
        out[node] = BridgeResult(bridge_score=round(score, 6), communities_touched=len(ties), ties=ties)
    return out


# ============================================================
# Combine
# ============================================================

@dataclass(frozen=True)
class AuthorInfluence:
    author_id: int
    degree_centrality: float
    betweenness_centrality: float
    pagerank: float
    bridge_score: float
    communities_touched: int
    ties: list[CommunityTie] = field(default_factory=list)


def compute_influence(g: nx.Graph, author_community: Mapping[int, int]) -> list[AuthorInfluence]:
    """All four metrics for every author currently in the collaboration
    graph, sorted by (bridge_score desc, pagerank desc, author_id) --
    bridge-researcher listings are F4's headline acceptance criterion, so
    that is the natural default order; callers that want a different one
    (e.g. `/authors?sort=citations`-style) re-sort in SQL, same as every
    other list endpoint in this codebase."""
    deg = degree_centrality(g)
    bet = betweenness_centrality(g)
    pr = pagerank_scores(g)
    bridge = participation_coefficients(g, author_community)

    results = [
        AuthorInfluence(
            author_id=node,
            degree_centrality=deg.get(node, 0.0),
            betweenness_centrality=bet.get(node, 0.0),
            pagerank=pr.get(node, 0.0),
            bridge_score=bridge[node].bridge_score,
            communities_touched=bridge[node].communities_touched,
            ties=bridge[node].ties,
        )
        for node in g.nodes()
    ]
    results.sort(key=lambda r: (-r.bridge_score, -r.pagerank, r.author_id))
    return results
