"""
M4 — Part 1 (F2): the pure half of community detection.

Everything here is a plain function over in-memory data — NetworkX graphs,
dicts, sets. No Postgres, no MongoDB. That is deliberate: `graph.communities`
owns the I/O (read the graph, write RESEARCH_COMMUNITY / COMMUNITY_MEMBER,
snapshot to Mongo), and this module owns the decisions, so each decision can
be unit-tested with a hand-built graph and no database.

Four decisions live here, each documented where it is made:

  1. detect_communities   Louvain on the author-collaboration graph, made
                          deterministic, with a minimum community size.
  2. membership_scores    How embedded each author is in their community.
  3. label_community      A human-readable label from dominant sub-topics.
  4. algorithm_label      The string stored in RESEARCH_COMMUNITY.Algorithm so
                          a run can be reproduced from Postgres alone (NFR:
                          "timestamped and re-producible").
"""
from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

import networkx as nx

ALGORITHM_NAME = "louvain"
DEFAULT_RESOLUTION = 1.0
DEFAULT_SEED = 42

# A "community" of one or two authors is a collaboration, not a community, and
# it would drown the dashboard in noise. Louvain also returns every isolated
# author as their own singleton; those are dropped before the algorithm runs.
DEFAULT_MIN_SIZE = 3

# Labeling. A topic is a candidate label term for a community only if it
# covers at least this share of the community's (author-weighted) papers.
LABEL_MIN_SHARE = 0.2
LABEL_DISTINCTIVE_TERMS = 1     # label = root topic + this many distinctive topics
EVIDENCE_TOPICS = 6             # how many scored topics are kept as evidence


# ============================================================
# 1. Detection
# ============================================================

def algorithm_label(resolution: float, seed: int) -> str:
    """e.g. 'louvain(resolution=1,seed=42)'. Fits VARCHAR(50) for any seed up to
    2**32 and any resolution, because ':g' caps the mantissa at 6 digits."""
    return f"{ALGORITHM_NAME}(resolution={resolution:g},seed={seed})"


@dataclass(frozen=True)
class Partition:
    communities: list[frozenset[int]]   # kept communities: size desc, then smallest author id
    modularity: float                   # of Louvain's full partition, before the size filter
    found: int                          # communities Louvain returned (isolates excluded)
    unassigned: int                     # authors that ended up in no kept community


def _validate(resolution: float, seed: int, min_size: int) -> None:
    if not resolution > 0:
        raise ValueError(f"resolution must be > 0, got {resolution!r}")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2**32 - 1:
        raise ValueError(f"seed must be an integer in [0, 2**32), got {seed!r}")
    if not isinstance(min_size, int) or min_size < 1:
        raise ValueError(f"min_size must be an integer >= 1, got {min_size!r}")


def canonical_graph(g: nx.Graph) -> nx.Graph:
    """A copy of `g` that depends only on its content, never on the order it
    was built in: nodes and edges inserted in sorted order, isolated authors
    left out, only the `weight` attribute kept.

    Louvain visits nodes in insertion order, so without this two builds of the
    same data (SQL returns rows in whatever order it likes) could give
    different partitions even with a fixed seed."""
    edges = []
    for u, v, d in g.edges(data=True):
        w = float(d.get("weight", 1.0))
        if u != v and w > 0:
            edges.append((min(u, v), max(u, v), w))
    edges.sort()
    h = nx.Graph()
    h.add_nodes_from(sorted({n for u, v, _ in edges for n in (u, v)}))
    h.add_weighted_edges_from(edges)
    return h


def detect_communities(
    g: nx.Graph,
    *,
    resolution: float = DEFAULT_RESOLUTION,
    seed: int = DEFAULT_SEED,
    min_size: int = DEFAULT_MIN_SIZE,
) -> Partition:
    """Louvain modularity optimisation on the weighted author graph.

    Why Louvain: it is what the PRD names (F2), needs no cluster count up
    front, uses the edge weights the graph builder worked to calibrate, and
    ships with NetworkX (already a dependency).

    `resolution` > 1 gives more, smaller communities; < 1 fewer, larger ones.
    Louvain is a hard partition: every author is in at most one community.
    """
    _validate(resolution, seed, min_size)
    h = canonical_graph(g)
    if h.number_of_edges() == 0:
        return Partition([], 0.0, 0, g.number_of_nodes())

    raw = nx.community.louvain_communities(h, weight="weight", resolution=resolution, seed=seed)
    modularity = float(nx.community.modularity(h, raw, weight="weight", resolution=resolution))
    kept = sorted((frozenset(c) for c in raw if len(c) >= min_size), key=lambda c: (-len(c), min(c)))
    assigned = sum(len(c) for c in kept)
    return Partition(kept, modularity, len(raw), g.number_of_nodes() - assigned)


# ============================================================
# 2. Membership score
# ============================================================

def membership_scores(g: nx.Graph, members: Iterable[int]) -> dict[int, float]:
    """Share of an author's total edge weight that stays inside their community,
    in [0, 1] (stored in COMMUNITY_MEMBER.Membership_Score).

    1.0 = every tie is to a community-mate; low values mean the author's ties
    are spread over other communities, which is exactly the signal M4's
    bridge-researcher score (F4) will build on."""
    inside = set(members)
    out: dict[int, float] = {}
    for a in sorted(inside):
        total = internal = 0.0
        for nbr, d in g[a].items():
            w = float(d.get("weight", 1.0))
            total += w
            if nbr in inside:
                internal += w
        out[a] = round(internal / total, 4) if total > 0 else 0.0
    return out


# ============================================================
# 3. Labels from dominant sub-topics
# ============================================================

@dataclass(frozen=True)
class TopicEvidence:
    topic_id: int
    name: str
    share: float          # fraction of the community's papers carrying this topic
    corpus_share: float   # fraction of ALL papers carrying it
    score: float          # share * ln(1 / corpus_share): high = common here, rare elsewhere


@dataclass(frozen=True)
class CommunityLabel:
    label: str
    root_topic_id: int | None
    evidence: list[TopicEvidence] = field(default_factory=list)


@dataclass
class LabelContext:
    """Corpus-level lookups, built once and reused for every community."""
    paper_authors: dict[int, set[int]]
    paper_topics: dict[int, set[int]]       # only papers that have authors
    topic_names: dict[int, str]
    author_papers: dict[int, list[int]]
    corpus_share: dict[int, float]

    @classmethod
    def build(
        cls,
        paper_authors: Mapping[int, set[int]],
        paper_topics: Mapping[int, Iterable[int]],
        topic_names: Mapping[int, str],
    ) -> "LabelContext":
        authored = {p: set(a) for p, a in paper_authors.items() if a}
        author_papers: dict[int, list[int]] = defaultdict(list)
        for p in sorted(authored):
            for a in authored[p]:
                author_papers[a].append(p)
        topics = {p: set(t) for p, t in paper_topics.items() if p in authored}
        counts: dict[int, int] = defaultdict(int)
        for ts in topics.values():
            for t in ts:
                counts[t] += 1
        total = len(authored) or 1
        return cls(
            paper_authors=authored,
            paper_topics=topics,
            topic_names=dict(topic_names),
            author_papers=dict(author_papers),
            corpus_share={t: n / total for t, n in counts.items()},
        )


def display_name(name: str) -> str:
    """Topic names are stored lower-cased; title-case them for a label unless
    the stored name already carries its own capitalisation (e.g. 'BERT')."""
    return name if any(c.isupper() for c in name) else name.title()


def label_community(members: frozenset[int], rank: int, ctx: LabelContext) -> CommunityLabel:
    """Label a community from the topics of the papers its members wrote.

    Method (TF-IDF, one level up from extract_topics.py):
      * Each paper counts for the community in proportion to how many of its
        authors are members. A paper written 3-to-1 by outsiders barely moves
        the label, which keeps a few cross-community papers from stamping
        another community's topics onto this one.
      * share(t)  = weight of the community's papers tagged t / total weight.
      * score(t)  = share(t) * ln(1 / corpus_share(t)). A topic on every paper
        in the corpus (e.g. "federated learning" in the demo corpus) has
        ln(1) = 0 and can never be the *distinctive* term.
      * Root topic = the topic covering the largest share of the community's
        papers (ties: the corpus-wider topic, then name). It anchors the label
        and is stored in RESEARCH_COMMUNITY.Root_Topic_ID. It is not a
        hierarchy parent: extract_topics leaves Parent_Topic_ID empty.
      * Label = root + the most distinctive other topic, giving the PRD's
        "Federated Learning + Privacy" shape.

    Falls back to "Community <rank>" when no topic covers >= LABEL_MIN_SHARE
    of the community's papers (e.g. topic extraction has not run).
    """
    weights: dict[int, float] = {}
    for a in sorted(members):
        for p in ctx.author_papers.get(a, ()):
            if p not in weights:
                authors = ctx.paper_authors[p]
                weights[p] = len(authors & members) / len(authors)
    total = sum(weights[p] for p in sorted(weights))
    fallback = CommunityLabel(label=f"Community {rank}", root_topic_id=None)
    if total <= 0:
        return fallback

    topic_weight: dict[int, float] = defaultdict(float)
    for p in sorted(weights):
        for t in ctx.paper_topics.get(p, ()):
            topic_weight[t] += weights[p]

    scored: list[TopicEvidence] = []
    for t, w in topic_weight.items():
        share = w / total
        if share < LABEL_MIN_SHARE or t not in ctx.topic_names:
            continue
        corpus = ctx.corpus_share.get(t, 0.0)
        idf = math.log(1.0 / corpus) if corpus > 0 else 0.0
        scored.append(TopicEvidence(t, ctx.topic_names[t], round(share, 4), round(corpus, 4), round(share * idf, 4)))
    if not scored:
        return fallback

    root = min(scored, key=lambda e: (-e.share, -e.corpus_share, e.name))
    distinctive = sorted(
        (e for e in scored if e.score > 0 and e.topic_id != root.topic_id),
        key=lambda e: (-e.score, -e.share, e.name),
    )
    parts = [root, *distinctive[:LABEL_DISTINCTIVE_TERMS]]
    label = " + ".join(display_name(e.name) for e in parts)
    others = sorted((e for e in scored if e.topic_id != root.topic_id), key=lambda e: (-e.score, -e.share, e.name))
    evidence = [root, *others[: EVIDENCE_TOPICS - 1]]     # root first, then by distinctiveness
    return CommunityLabel(label=label, root_topic_id=root.topic_id, evidence=evidence)
