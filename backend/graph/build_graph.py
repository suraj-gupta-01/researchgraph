"""
M3 — Part 2: Graph construction (PRD F2/F4/G4).

Builds the Author-Paper-Institution-Topic-Venue-Citation graph (PRD Section
7.2) directly from the current contents of Postgres, as in-memory NetworkX
graphs handed to M4's community-detection / centrality jobs. This milestone
stops at *construction*; running Louvain, betweenness centrality, PageRank,
etc. is explicitly M4's job (PRD Section 10) and is not attempted here.

Two graphs come out, because M4's two families of algorithms need different
shapes:

  * `build_full_graph()` — the literal heterogeneous graph from Section 7.2.
    Every AUTHOR / PAPER / INSTITUTION / TOPIC / VENUE row is a node; every
    AUTHORSHIP / AUTHOR_INSTITUTION / PAPER_TOPIC / CITATION row is an edge
    (VENUE is 1:M so a paper's venue is folded in as a `published_in` edge
    rather than needing its own join table). This is the substrate for
    anything that wants the full entity graph — e.g. F4's per-author
    centrality when institutions/topics should count towards a bridge score,
    not just co-authorship.

  * `build_author_collaboration_graph()` — projects the heterogeneous graph
    down onto authors, per F2's explicit edge list: "co-authorship (via
    AUTHORSHIP), citation (CITATION), shared-topic (PAPER_TOPIC),
    institutional collaboration (COLLABORATION)". RESEARCH_COMMUNITY /
    COMMUNITY_MEMBER (which F2's Louvain run will populate in M4) only track
    Author_ID, so the community-detection input has to already be an
    author-author graph, not the heterogeneous one. Each of the four PRD
    signals contributes independently to the same undirected edge weight;
    see the WEIGHT_* / *_THRESHOLD constants below for the exact rule.

Both are pure reads (no writes to Postgres) and safe to call at any point in
the pipeline, including with an empty database. A lightweight summary
(node/edge counts by type, basic weight stats) is written to MongoDB
(`graph_snapshot`, PRD 6.4's "graph-analysis result blobs") so a dashboard
or evaluator can see the graph is populated without rebuilding it, and so M4
has a fast sanity check before running anything expensive. If Mongo is
unreachable the summary is still returned and logged; only the persistence
step is skipped.
"""
from __future__ import annotations

import itertools
import logging
from datetime import datetime, timezone

import networkx as nx
from sqlalchemy import text

from app.db import get_engine, get_mongo_db

log = logging.getLogger("researchgraph.build_graph")

# --- heterogeneous graph: edge "kind" tags -----------------------------
EDGE_AUTHORSHIP = "authorship"
EDGE_AFFILIATION = "affiliation"
EDGE_HAS_TOPIC = "has_topic"
EDGE_PUBLISHED_IN = "published_in"
EDGE_CITES = "cites"

# --- author-collaboration graph: per-signal weights (F2) ----------------
# Co-authorship is the strongest signal (direct, first-hand evidence of
# working together) and dominates the other three, which are progressively
# weaker/indirect evidence of belonging to the same community.
WEIGHT_COAUTHOR = 3.0        # per shared paper
WEIGHT_CITATION = 1.0        # per citing-author/cited-author pair
WEIGHT_SHARED_TOPIC = 0.5    # per non-dominant topic both have published on
WEIGHT_INSTITUTIONAL = 0.75  # per COLLABORATION-linked institution pair between them

# A topic tagged on virtually every paper (e.g. "federated learning" in the
# seed_dev corpus) carries no discriminative signal about which sub-community
# an author belongs to — mirrors the IDF-dilution reasoning extract_topics.py
# already applies within a single paper, just applied here at the corpus
# level. Topics above this fraction of the corpus are excluded from the
# shared-topic signal entirely.
DOMINANT_TOPIC_FRACTION = 0.4
SHARED_TOPIC_MIN_RELEVANCE = 0.3

# Safety cap: an institution with more affiliated authors than this is
# excluded from the institutional-collaboration signal, since connecting
# every pair across two such institutions is O(n*m) and, at that size, "both
# affiliated with a big university" stops being meaningful community
# evidence anyway. Not exercised at the class-project corpus scale this
# system targets (PRD Section 11).
MAX_INSTITUTION_FANOUT = 60


def _nid(kind: str, entity_id: int) -> str:
    return f"{kind}:{entity_id}"


# ============================================================
# Full heterogeneous graph (G4)
# ============================================================

def build_full_graph() -> nx.MultiDiGraph:
    """The Author-Paper-Institution-Topic-Venue-Citation graph, straight off
    the relational schema. Node IDs are "{table}:{primary key}" so the five
    entity types can never collide in one graph; edges carry a `kind` tag so
    a single edge type can be filtered back out (e.g. `nx.MultiDiGraph`
    doesn't let you query "just the citation edges" any other way)."""
    engine = get_engine()
    g = nx.MultiDiGraph()

    with engine.connect() as conn:
        for r in conn.execute(text("SELECT Author_ID, Full_Name FROM AUTHOR")).mappings():
            g.add_node(_nid("author", r["author_id"]), type="author", label=r["full_name"])

        for r in conn.execute(
            text("SELECT Paper_ID, Title, Publication_Year, Citation_Count FROM PAPER")
        ).mappings():
            g.add_node(
                _nid("paper", r["paper_id"]), type="paper", label=r["title"],
                year=r["publication_year"], citation_count=r["citation_count"],
            )

        for r in conn.execute(text("SELECT Institution_ID, Institution_Name, Country FROM INSTITUTION")).mappings():
            g.add_node(
                _nid("institution", r["institution_id"]), type="institution",
                label=r["institution_name"], country=r["country"],
            )

        for r in conn.execute(text("SELECT Topic_ID, Topic_Name, Parent_Topic_ID FROM TOPIC")).mappings():
            g.add_node(
                _nid("topic", r["topic_id"]), type="topic", label=r["topic_name"],
                parent_topic_id=r["parent_topic_id"],
            )

        for r in conn.execute(text("SELECT Venue_ID, Venue_Name, Venue_Type FROM VENUE")).mappings():
            g.add_node(
                _nid("venue", r["venue_id"]), type="venue", label=r["venue_name"],
                venue_type=r["venue_type"],
            )

        for r in conn.execute(
            text("SELECT Author_ID, Paper_ID, Author_Position, Is_Corresponding FROM AUTHORSHIP")
        ).mappings():
            g.add_edge(
                _nid("author", r["author_id"]), _nid("paper", r["paper_id"]),
                key="authorship", kind=EDGE_AUTHORSHIP,
                position=r["author_position"], is_corresponding=r["is_corresponding"],
            )

        for r in conn.execute(
            text("SELECT Author_ID, Institution_ID, Start_Year, End_Year FROM AUTHOR_INSTITUTION")
        ).mappings():
            # (Author_ID, Institution_ID) can recur with a different Start_Year
            # (PK includes it), so the edge key has to include it too, or a
            # second affiliation row would silently overwrite the first.
            g.add_edge(
                _nid("author", r["author_id"]), _nid("institution", r["institution_id"]),
                key=f"affiliation:{r['start_year']}", kind=EDGE_AFFILIATION,
                start_year=r["start_year"], end_year=r["end_year"],
            )

        for r in conn.execute(
            text("SELECT Paper_ID, Topic_ID, Relevance_Score, Extraction_Method FROM PAPER_TOPIC")
        ).mappings():
            g.add_edge(
                _nid("paper", r["paper_id"]), _nid("topic", r["topic_id"]),
                key="has_topic", kind=EDGE_HAS_TOPIC,
                relevance=float(r["relevance_score"]), method=r["extraction_method"],
            )

        for r in conn.execute(text("SELECT Paper_ID, Venue_ID FROM PAPER WHERE Venue_ID IS NOT NULL")).mappings():
            g.add_edge(
                _nid("paper", r["paper_id"]), _nid("venue", r["venue_id"]),
                key="published_in", kind=EDGE_PUBLISHED_IN,
            )

        for r in conn.execute(text("SELECT Citing_Paper_ID, Cited_Paper_ID FROM CITATION")).mappings():
            g.add_edge(
                _nid("paper", r["citing_paper_id"]), _nid("paper", r["cited_paper_id"]),
                key="cites", kind=EDGE_CITES,
            )

    return g


def full_graph_summary(g: nx.MultiDiGraph) -> dict:
    node_counts: dict[str, int] = {}
    for _, data in g.nodes(data=True):
        node_counts[data.get("type", "unknown")] = node_counts.get(data.get("type", "unknown"), 0) + 1
    edge_counts: dict[str, int] = {}
    for _, _, data in g.edges(data=True):
        edge_counts[data.get("kind", "unknown")] = edge_counts.get(data.get("kind", "unknown"), 0) + 1
    return {
        "nodes": g.number_of_nodes(),
        "edges": g.number_of_edges(),
        "node_counts": node_counts,
        "edge_counts": edge_counts,
    }


# ============================================================
# Author-collaboration graph (F2's community-detection input)
# ============================================================

def _paper_author_map(conn) -> dict[int, set[int]]:
    m: dict[int, set[int]] = {}
    for pid, aid in conn.execute(text("SELECT Paper_ID, Author_ID FROM AUTHORSHIP")).all():
        m.setdefault(pid, set()).add(aid)
    return m


def _institution_author_map(conn) -> dict[int, set[int]]:
    # M4 pre-work: sourced from PAPER_AUTHOR_INSTITUTION rather than
    # AUTHOR_INSTITUTION, so an author with two affiliations in one year only
    # links into the institution actually carried on a given paper, not both
    # institutions on every paper they wrote that year.
    m: dict[int, set[int]] = {}
    for aid, iid in conn.execute(text("SELECT DISTINCT Author_ID, Institution_ID FROM PAPER_AUTHOR_INSTITUTION")).all():
        m.setdefault(iid, set()).add(aid)
    return {iid: authors for iid, authors in m.items() if len(authors) <= MAX_INSTITUTION_FANOUT}


def _shared_topic_author_groups(conn, paper_authors: dict[int, set[int]]) -> list[set[int]]:
    """For each TOPIC that is neither corpus-wide nor paper-unique, the set
    of authors who wrote at least one paper tagged with it above
    SHARED_TOPIC_MIN_RELEVANCE. See DOMINANT_TOPIC_FRACTION for why
    corpus-wide topics are excluded."""
    total_papers = len(paper_authors) or 1
    topic_papers: dict[int, set[int]] = {}
    rows = conn.execute(
        text("SELECT Paper_ID, Topic_ID FROM PAPER_TOPIC WHERE Relevance_Score >= :min_rel"),
        {"min_rel": SHARED_TOPIC_MIN_RELEVANCE},
    ).all()
    for pid, tid in rows:
        topic_papers.setdefault(tid, set()).add(pid)

    groups: list[set[int]] = []
    for pids in topic_papers.values():
        if len(pids) < 2 or len(pids) > DOMINANT_TOPIC_FRACTION * total_papers:
            continue
        authors: set[int] = set()
        for pid in pids:
            authors |= paper_authors.get(pid, set())
        if len(authors) >= 2:
            groups.append(authors)
    return groups


def build_author_collaboration_graph() -> nx.Graph:
    """Undirected, weighted Author-Author graph combining F2's four edge
    sources. Each contributes to `weight` independently and is also broken
    out under its own attribute (`coauthor_weight`, `citation_weight`,
    `shared_topic_weight`, `institutional_weight`) so a later community
    label or bridge score can explain *why* two authors are connected, not
    just that they are."""
    engine = get_engine()
    with engine.connect() as conn:
        authors = conn.execute(text("SELECT Author_ID, Full_Name FROM AUTHOR")).mappings().all()
        paper_authors = _paper_author_map(conn)
        citation_edges = conn.execute(text("SELECT Citing_Paper_ID, Cited_Paper_ID FROM CITATION")).all()
        topic_groups = _shared_topic_author_groups(conn, paper_authors)
        inst_authors = _institution_author_map(conn)
        # Normalise to (low, high): if COLLABORATION ever stores a pair in both
        # orders, each institution pair must still contribute exactly once.
        collab_pairs = {
            (min(a, b), max(a, b))
            for a, b in conn.execute(text("SELECT DISTINCT Institution_A_ID, Institution_B_ID FROM COLLABORATION")).all()
            if a != b
        }

    g = nx.Graph()
    for r in authors:
        g.add_node(r["author_id"], label=r["full_name"])

    def bump(a: int, b: int, signal: str, amount: float) -> None:
        if a == b:
            return
        u, v = (a, b) if a < b else (b, a)
        if g.has_edge(u, v):
            data = g[u][v]
            data["weight"] += amount
            data[signal] = data.get(signal, 0.0) + amount
        else:
            g.add_edge(u, v, weight=amount, **{signal: amount})

    # 1. Co-authorship — one bump per shared paper.
    for paper_id_authors in paper_authors.values():
        for a, b in itertools.combinations(sorted(paper_id_authors), 2):
            bump(a, b, "coauthor_weight", WEIGHT_COAUTHOR)

    # 2. Citation — connects the *authors* of a citing/cited paper pair, not
    #    just the papers, since community detection here runs on authors.
    for citing_id, cited_id in citation_edges:
        for a in paper_authors.get(citing_id, ()):
            for b in paper_authors.get(cited_id, ()):
                bump(a, b, "citation_weight", WEIGHT_CITATION)

    # 3. Shared topic — authors who have each published on the same
    #    non-dominant topic, even if they never co-authored a paper.
    for group in topic_groups:
        for a, b in itertools.combinations(sorted(group), 2):
            bump(a, b, "shared_topic_weight", WEIGHT_SHARED_TOPIC)

    # 4. Institutional collaboration — authors at two institutions that
    #    COLLABORATION already shows have worked together (on some paper,
    #    not necessarily one either of these two authors wrote), so this can
    #    surface a link co-authorship/citation/topic signals would miss.
    for inst_a, inst_b in collab_pairs:
        for a in inst_authors.get(inst_a, ()):
            for b in inst_authors.get(inst_b, ()):
                bump(a, b, "institutional_weight", WEIGHT_INSTITUTIONAL)

    return g


def collaboration_graph_summary(g: nx.Graph) -> dict:
    weights = [d["weight"] for _, _, d in g.edges(data=True)]
    return {
        "authors": g.number_of_nodes(),
        "edges": g.number_of_edges(),
        "isolated_authors": sum(1 for n in g.nodes() if g.degree(n) == 0),
        "max_weight": max(weights) if weights else 0.0,
        "avg_weight": round(sum(weights) / len(weights), 4) if weights else 0.0,
    }


# ============================================================
# Entry point: build both, summarize, snapshot to Mongo
# ============================================================

def build_and_summarize() -> dict:
    """Builds both graphs against the current Postgres contents and returns
    a JSON-safe summary. Also upserts that summary into MongoDB
    (`graph_snapshot`, single document keyed `_id: "latest"`) so the
    dashboard / M4 can check the graph is populated without rebuilding it;
    a Mongo failure only drops the persistence step, not the return value."""
    full = build_full_graph()
    collab = build_author_collaboration_graph()
    summary = {
        "_id": "latest",
        "built_at": datetime.now(timezone.utc).isoformat(),
        "full_graph": full_graph_summary(full),
        "author_collaboration_graph": collaboration_graph_summary(collab),
    }
    try:
        get_mongo_db()["graph_snapshot"].replace_one({"_id": "latest"}, summary, upsert=True)
    except Exception:
        log.warning("Could not persist graph snapshot to MongoDB", exc_info=True)
    log.info("Graph construction: %s", summary)
    return summary


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    build_and_summarize()
