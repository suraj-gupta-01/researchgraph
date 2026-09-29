"""
M4 -- Part 3: Researcher influence & bridge detection (PRD F4).

Runs the four `graph.influence_core` metrics over the author-collaboration
graph M3 builds (the same one Part 1's Louvain run partitions) and persists
them to AUTHOR_INFLUENCE / AUTHOR_COMMUNITY_TIE. The metrics themselves
(degree/betweenness centrality, PageRank, participation-coefficient bridge
score) are in graph.influence_core (pure, unit-testable); this module is the
I/O around them -- same split as M4 Parts 1 and 2.

    docker compose exec backend python -m graph.influence
    docker compose exec backend python -m graph.influence --dry-run

Run semantics (PRD Section 8, auditability):
  * A run REPLACES the entire table: unlike RESEARCH_COMMUNITY / TOPIC_SNAPSHOT
    (which key on an Algorithm prefix so a differently-parametrized run's rows
    can be told apart), AUTHOR_INFLUENCE is one row per author with no
    parameters to vary between runs (`influence_core.algorithm_label()` takes
    no arguments), so there is only ever one current run to replace.
  * The whole replace (both tables) is one transaction: a failure leaves the
    previous run in place rather than a half-written one.
  * The run is also written to MongoDB (`graph_snapshot`, `_id: "influence"`,
    PRD 6.4's "graph-analysis result blobs"): parameters (none), counts, and
    the top bridge researchers by score. If Mongo is down the run still
    succeeds.

Precondition: `graph.communities` (M4 Part 1) has run. Without RESEARCH_COMMUNITY
rows the four centrality metrics are still computed normally (they only need
the collaboration graph), but every author's bridge_score is 0 and
communities_touched is 0 -- there is nothing to bridge yet. AUTHOR_COMMUNITY_TIE
rows reference RESEARCH_COMMUNITY with ON DELETE CASCADE, so a later
`graph.communities` re-run (which deletes and reinserts RESEARCH_COMMUNITY)
silently drops this run's ties too; re-run `graph.influence` after re-running
`graph.communities` to pick the new partition back up.
"""
from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone

from sqlalchemy import text

from app.db import get_engine, get_mongo_db
from graph.build_graph import build_author_collaboration_graph, collaboration_graph_summary
from graph.influence_core import AuthorInfluence, algorithm_label, compute_influence

log = logging.getLogger("researchgraph.influence")

SNAPSHOT_COLLECTION = "graph_snapshot"
SNAPSHOT_ID = "influence"

# The PRD's own bar for a "bridge researcher": "connecting >= 2 distinct
# communities". Used both for the Mongo snapshot's headline list and as the
# default floor the /authors/bridges API applies (see routers/authors.py).
MIN_COMMUNITIES_FOR_BRIDGE = 2


def _author_community_map(conn) -> dict[int, int]:
    """Author_ID -> Community_ID for the CURRENT community run. Deliberately
    a plain last-write-wins dict even though Louvain is a hard partition (an
    author is a COMMUNITY_MEMBER of at most one community), so a stale
    duplicate row could never silently pick the wrong one."""
    return dict(conn.execute(text("SELECT Author_ID, Community_ID FROM COMMUNITY_MEMBER")).all())


def _store(conn, results: list[AuthorInfluence], *, algorithm: str, detected_at: datetime) -> None:
    """Replace the previous run in both tables. Caller owns the transaction."""
    conn.execute(text("DELETE FROM AUTHOR_COMMUNITY_TIE"))
    conn.execute(text("DELETE FROM AUTHOR_INFLUENCE"))

    if not results:
        return

    conn.execute(
        text(
            "INSERT INTO AUTHOR_INFLUENCE "
            "(Author_ID, Degree_Centrality, Betweenness_Centrality, Pagerank, Bridge_Score, "
            " Communities_Touched, Detection_Date, Algorithm) "
            "VALUES (:author_id, :degree_centrality, :betweenness_centrality, :pagerank, :bridge_score, "
            "        :communities_touched, :ts, :algo)"
        ),
        [
            {
                "author_id": r.author_id,
                "degree_centrality": r.degree_centrality,
                "betweenness_centrality": r.betweenness_centrality,
                "pagerank": r.pagerank,
                "bridge_score": r.bridge_score,
                "communities_touched": r.communities_touched,
                "ts": detected_at,
                "algo": algorithm,
            }
            for r in results
        ],
    )

    tie_rows = [
        {"author_id": r.author_id, "community_id": t.community_id, "weight": t.weight, "share": t.share}
        for r in results
        for t in r.ties
    ]
    if tie_rows:
        conn.execute(
            text(
                "INSERT INTO AUTHOR_COMMUNITY_TIE (Author_ID, Community_ID, Tie_Weight, Tie_Share) "
                "VALUES (:author_id, :community_id, :weight, :share)"
            ),
            tie_rows,
        )


def detect_and_store(*, dry_run: bool = False) -> dict:
    """Compute and (unless dry_run) persist influence/bridge scores for every
    author in the collaboration graph. Returns a JSON-safe summary; the same
    document is what lands in Mongo."""
    algorithm = algorithm_label()
    detected_at = datetime.now(timezone.utc)

    engine = get_engine()
    with (engine.connect() if dry_run else engine.begin()) as conn:
        graph = build_author_collaboration_graph()
        author_community = _author_community_map(conn)
        results = compute_influence(graph, author_community)
        if not dry_run:
            _store(conn, results, algorithm=algorithm, detected_at=detected_at)

    bridges = [r for r in results if r.communities_touched >= MIN_COMMUNITIES_FOR_BRIDGE]
    summary = {
        "_id": SNAPSHOT_ID,
        "detected_at": detected_at.isoformat(),
        "algorithm": algorithm,
        "dry_run": dry_run,
        "graph": collaboration_graph_summary(graph),
        "authors_scored": len(results),
        "communities_in_partition": len(set(author_community.values())),
        "bridge_researchers_found": len(bridges),
        "top_bridges": [
            {
                "author_id": r.author_id,
                "bridge_score": r.bridge_score,
                "communities_touched": r.communities_touched,
                "pagerank": r.pagerank,
                "betweenness_centrality": r.betweenness_centrality,
            }
            for r in bridges[:10]
        ],
    }

    if not dry_run:
        try:
            get_mongo_db()[SNAPSHOT_COLLECTION].replace_one({"_id": SNAPSHOT_ID}, summary, upsert=True)
        except Exception:                # noqa: BLE001 - Mongo is an optional sink for this job
            log.warning("Could not persist influence snapshot to MongoDB", exc_info=True)

    log.info(
        "Influence%s: %d authors scored, %d bridge researchers (>= %d communities) of %d in %d communities",
        " (dry run)" if dry_run else "", summary["authors_scored"], summary["bridge_researchers_found"],
        MIN_COMMUNITIES_FOR_BRIDGE, graph.number_of_nodes(), summary["communities_in_partition"],
    )
    return summary


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Compute and store researcher influence & bridge scores (F4).")
    parser.add_argument("--dry-run", action="store_true", help="Compute and log, write nothing")
    args = parser.parse_args()
    detect_and_store(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
