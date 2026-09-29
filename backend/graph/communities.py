"""
M4 — Part 1: Research community detection (PRD F2).

Runs Louvain over the author-collaboration graph M3 builds, labels each
community from its dominant sub-topics, and persists the result to
RESEARCH_COMMUNITY / COMMUNITY_MEMBER. The decisions (partitioning, labels,
membership score) are in graph.community_core; this module is the I/O around
them.

    docker compose exec backend python -m graph.communities
    docker compose exec backend python -m graph.communities --resolution 1.3 --dry-run

Run semantics (PRD Section 8, auditability):
  * A run REPLACES the previous run. Postgres always holds exactly one,
    current, consistent set of communities, so the API never has to pick a
    "latest" among several. Every row of a run shares one Detection_Date, and
    Algorithm records the parameters ('louvain(resolution=1,seed=42)'), so a
    stored result can be reproduced from Postgres alone.
  * The same data + parameters give the same partition (the graph is put in a
    canonical order and Louvain is seeded). Community_IDs are new each run.
  * The whole replace is one transaction: a failure leaves the previous run
    in place rather than an empty table.
  * The run is also written to MongoDB (`graph_snapshot`, `_id: "communities"`,
    PRD 6.4's "graph-analysis result blobs"): parameters, modularity, and the
    per-community label evidence. If Mongo is down the run still succeeds.

Precondition: topic extraction (M3 Part 1) has run. Without PAPER_TOPIC rows
communities are still found, but labelled "Community <n>".
"""
from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone

from sqlalchemy import text

from app.db import get_engine, get_mongo_db
from graph.build_graph import (
    SHARED_TOPIC_MIN_RELEVANCE,
    _paper_author_map,
    build_author_collaboration_graph,
    collaboration_graph_summary,
)
from graph.community_core import (
    ALGORITHM_NAME,
    DEFAULT_MIN_SIZE,
    DEFAULT_RESOLUTION,
    DEFAULT_SEED,
    CommunityLabel,
    LabelContext,
    Partition,
    algorithm_label,
    detect_communities,
    label_community,
    membership_scores,
)

log = logging.getLogger("researchgraph.communities")

SNAPSHOT_COLLECTION = "graph_snapshot"
SNAPSHOT_ID = "communities"


def _load_label_context(conn) -> LabelContext:
    """Papers -> authors, papers -> topics, topic names. Topics below the same
    relevance floor the graph builder uses for its shared-topic signal are
    ignored, so labels and edges agree on what counts as 'a paper's topic'."""
    paper_authors = _paper_author_map(conn)
    paper_topics: dict[int, set[int]] = {}
    for pid, tid in conn.execute(
        text("SELECT Paper_ID, Topic_ID FROM PAPER_TOPIC WHERE Relevance_Score >= :min_rel"),
        {"min_rel": SHARED_TOPIC_MIN_RELEVANCE},
    ).all():
        paper_topics.setdefault(pid, set()).add(tid)
    topic_names = {tid: name for tid, name in conn.execute(text("SELECT Topic_ID, Topic_Name FROM TOPIC")).all()}
    return LabelContext.build(paper_authors, paper_topics, topic_names)


def _store(conn, partition: Partition, labels: list[CommunityLabel], scores: list[dict[int, float]],
           *, algorithm: str, detected_at: datetime) -> list[int]:
    """Replace the previous run with this one. Caller owns the transaction."""
    conn.execute(text("DELETE FROM RESEARCH_COMMUNITY WHERE Algorithm LIKE :prefix"), {"prefix": ALGORITHM_NAME + "%"})
    ids: list[int] = []
    for members, label, member_scores in zip(partition.communities, labels, scores):
        cid = conn.execute(
            text(
                "INSERT INTO RESEARCH_COMMUNITY (Label, Root_Topic_ID, Detection_Date, Algorithm) "
                "VALUES (:label, :root, :ts, :algo) RETURNING Community_ID"
            ),
            {"label": label.label, "root": label.root_topic_id, "ts": detected_at, "algo": algorithm},
        ).scalar_one()
        conn.execute(
            text("INSERT INTO COMMUNITY_MEMBER (Community_ID, Author_ID, Membership_Score) VALUES (:c, :a, :s)"),
            [{"c": cid, "a": a, "s": member_scores[a]} for a in sorted(members)],
        )
        ids.append(cid)
    return ids


def detect_and_store(
    *,
    resolution: float = DEFAULT_RESOLUTION,
    seed: int = DEFAULT_SEED,
    min_size: int = DEFAULT_MIN_SIZE,
    dry_run: bool = False,
) -> dict:
    """Detect, label and (unless dry_run) persist communities. Returns a
    JSON-safe summary; the same document is what lands in Mongo."""
    graph = build_author_collaboration_graph()
    partition = detect_communities(graph, resolution=resolution, seed=seed, min_size=min_size)
    algorithm = algorithm_label(resolution, seed)
    detected_at = datetime.now(timezone.utc)
    scores = [membership_scores(graph, members) for members in partition.communities]

    engine = get_engine()
    with (engine.connect() if dry_run else engine.begin()) as conn:
        ctx = _load_label_context(conn)
        labels = [label_community(members, rank, ctx) for rank, members in enumerate(partition.communities, start=1)]
        ids = [None] * len(labels) if dry_run else _store(
            conn, partition, labels, scores, algorithm=algorithm, detected_at=detected_at
        )

    summary = {
        "_id": SNAPSHOT_ID,
        "detected_at": detected_at.isoformat(),
        "algorithm": algorithm,
        "params": {"resolution": resolution, "seed": seed, "min_size": min_size},
        "dry_run": dry_run,
        "graph": collaboration_graph_summary(graph),
        "modularity": round(partition.modularity, 4),
        "communities_found": partition.found,
        "communities_kept": len(partition.communities),
        "authors_assigned": sum(len(c) for c in partition.communities),
        "authors_unassigned": partition.unassigned,
        "communities": [
            {
                "community_id": cid,
                "rank": rank,
                "label": label.label,
                "size": len(members),
                "root_topic_id": label.root_topic_id,
                "avg_membership_score": round(sum(sc.values()) / len(sc), 4),
                "topics": [
                    {"topic_id": e.topic_id, "topic_name": e.name, "share": e.share,
                     "corpus_share": e.corpus_share, "score": e.score}
                    for e in label.evidence
                ],
            }
            for rank, (cid, members, label, sc) in enumerate(zip(ids, partition.communities, labels, scores), start=1)
        ],
    }

    if not dry_run:
        try:
            get_mongo_db()[SNAPSHOT_COLLECTION].replace_one({"_id": SNAPSHOT_ID}, summary, upsert=True)
        except Exception:                # noqa: BLE001 - Mongo is an optional sink for this job
            log.warning("Could not persist community snapshot to MongoDB", exc_info=True)

    log.info(
        "Communities%s: %d kept of %d found, %d/%d authors assigned, modularity %.3f, labels: %s",
        " (dry run)" if dry_run else "", summary["communities_kept"], partition.found,
        summary["authors_assigned"], graph.number_of_nodes(), partition.modularity,
        [c["label"] for c in summary["communities"]],
    )
    return summary


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Detect and store research communities (F2).")
    parser.add_argument("--resolution", type=float, default=DEFAULT_RESOLUTION,
                        help="Louvain resolution; >1 gives more, smaller communities")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--min-size", type=int, default=DEFAULT_MIN_SIZE,
                        help="Communities with fewer authors are not stored")
    parser.add_argument("--dry-run", action="store_true", help="Compute and log, write nothing")
    args = parser.parse_args()
    detect_and_store(resolution=args.resolution, seed=args.seed, min_size=args.min_size, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
