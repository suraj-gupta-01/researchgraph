"""
M4 — Part 4b: Topic convergence detection (PRD F5), the I/O half.

Runs Part 4a's pure logic (graph.convergence_core) against Postgres:
counts, per year, how many papers carry each *pair* of topics, classifies
every (pair, year) with `classify_pair_series`, stores the result in
TOPIC_PAIR_TREND, and promotes the topics of converging pairs to the
'Converging' label in RESEARCH_TREND. Same split as Parts 1-3
(community_core/communities, trend_core/trends, influence_core/influence).

    docker compose exec backend python -m graph.convergence
    docker compose exec backend python -m graph.convergence --dry-run

Ordering (load-bearing): run `graph.trends` FIRST. Promotion turns a
'Stable' RESEARCH_TREND row into 'Converging', so Part 2's baseline has to
exist. And a later `graph.trends` re-run deletes and rewrites every
RESEARCH_TREND row under its Algorithm prefix -- promoted rows included,
because promotion never changes Algorithm -- so after re-running
`graph.trends`, re-run this module to reapply its promotions.

Aggregation
  * PAPER_TOPIC rows with Relevance_Score >= the same floor Parts 1-2 use
    (graph.build_graph.SHARED_TOPIC_MIN_RELEVANCE), so "paper is about
    topic" means the same thing in a community label, a topic snapshot and a
    pair count.
  * Per paper, only the MAX_TOPICS_PER_PAPER_FOR_PAIRS most relevant topics
    (ties broken by Topic_ID, so the cut is deterministic) are paired. A
    paper with k topics yields C(k,2) pairs, so this is a quadratic-blowup
    guard, not a routine truncation. `papers_truncated` in the summary says
    how many papers it actually cut, so a silent truncation is visible.
  * Every unordered pair on the same paper in the same year adds 1 to that
    (pair, year); pairs are canonicalised (low id, high id) via
    convergence_core.canonical_pair so (A,B) and (B,A) share one counter.

Promotion rule
  For every (topic, year) that appears in at least one converging pair this
  run, RESEARCH_TREND.Trend_Label becomes 'Converging' -- but only where it
  is currently 'Stable'. An 'Emerging' or 'Declining' label already says
  something more specific and is never overwritten. Score becomes the
  topic's strongest converging-pair score for that year. Algorithm and
  Detection_Date on the promoted row stay Part 2's; TOPIC_PAIR_TREND (own
  Algorithm/Detection_Date) is the audit trail for why it was promoted.
  Promotion is one-directional: re-running this module never demotes a row
  that no longer qualifies (a `graph.trends` re-run resets it).

Run semantics (PRD Section 8, auditability)
  * TOPIC_PAIR_TREND has no other writer, so a run replaces it wholesale
    (DELETE + reinsert). Replace and promotion happen in ONE transaction: a
    failure leaves the previous rows and promotions in place.
  * All rows of a run share one Detection_Date; Algorithm carries the
    thresholds, so a stored result is reproducible from Postgres alone.
  * The run summary is upserted to MongoDB (`graph_snapshot`, `_id:
    "convergence"`) for auditability. If Mongo is down the run still
    succeeds.
  * --dry-run does the whole thing inside a transaction that is rolled
    back, so the reported counts (including topics_promoted) are exact.

Precondition: topic extraction has run. Without PAPER_TOPIC rows the result
is empty, not an error.
"""
from __future__ import annotations

import argparse
import logging
from collections import defaultdict
from datetime import datetime, timezone
from itertools import combinations

from sqlalchemy import text

from app.db import get_engine, get_mongo_db
from graph.build_graph import SHARED_TOPIC_MIN_RELEVANCE
from graph.convergence_core import (
    CONVERGING_THRESHOLD,
    MIN_COOCCURRENCE_FOR_TREND,
    ConvergenceResult,
    algorithm_label,
    canonical_pair,
    classify_pair_series,
)

log = logging.getLogger("researchgraph.convergence")

SNAPSHOT_COLLECTION = "graph_snapshot"
SNAPSHOT_ID = "convergence"

MIN_RELEVANCE = SHARED_TOPIC_MIN_RELEVANCE
MAX_TOPICS_PER_PAPER_FOR_PAIRS = 12
TREND_CONVERGING = "Converging"
TREND_STABLE = "Stable"

_INSERT_CHUNK = 2000

_PAPER_TOPICS_SQL = """
SELECT pt.Paper_ID AS paper_id, p.Publication_Year AS year, pt.Topic_ID AS topic_id
FROM PAPER_TOPIC pt
JOIN PAPER p ON p.Paper_ID = pt.Paper_ID
WHERE pt.Relevance_Score >= :min_rel AND p.Publication_Year > 0
ORDER BY pt.Paper_ID, pt.Relevance_Score DESC, pt.Topic_ID
"""


def _count_cooccurrence(conn, min_relevance: float, max_topics: int):
    """-> ({(topic_a, topic_b): {year: papers_with_both}}, papers_seen, papers_truncated).

    One pass over PAPER_TOPIC, ordered so each paper's rows are contiguous
    and most-relevant first."""
    counts: dict[tuple[int, int], dict[int, int]] = defaultdict(lambda: defaultdict(int))
    papers_seen = papers_truncated = 0

    def flush(year: int | None, topics: list[int]) -> None:
        nonlocal papers_seen, papers_truncated
        if year is None:
            return
        papers_seen += 1
        if len(topics) > max_topics:
            papers_truncated += 1
            topics = topics[:max_topics]
        for a, b in combinations(sorted(set(topics)), 2):
            counts[canonical_pair(a, b)][year] += 1

    current_paper: int | None = None
    current_year: int | None = None
    current_topics: list[int] = []
    for row in conn.execute(text(_PAPER_TOPICS_SQL), {"min_rel": min_relevance}).mappings():
        if row["paper_id"] != current_paper:
            flush(current_year, current_topics)
            current_paper, current_year, current_topics = row["paper_id"], row["year"], []
        current_topics.append(row["topic_id"])
    flush(current_year, current_topics)

    return {pair: dict(years) for pair, years in counts.items()}, papers_seen, papers_truncated


def _store_pairs(conn, results: dict[tuple[int, int, int], ConvergenceResult],
                 *, algorithm: str, detected_at: datetime) -> None:
    """Replace the previous run's TOPIC_PAIR_TREND rows. Caller owns the transaction."""
    conn.execute(text("DELETE FROM TOPIC_PAIR_TREND"))
    rows = [
        {
            "a": a, "b": b, "year": year, "count": r.cooccurrence_count,
            "prior": r.prior_cooccurrence_count, "growth": r.growth_rate,
            "score": r.convergence_score, "conv": r.is_converging,
            "ts": detected_at, "algo": algorithm,
        }
        for (a, b, year), r in results.items()
    ]
    stmt = text(
        "INSERT INTO TOPIC_PAIR_TREND (Topic_A_ID, Topic_B_ID, Period_Year, Cooccurrence_Count, "
        "Prior_Cooccurrence_Count, Growth_Rate, Convergence_Score, Is_Converging, Detection_Date, Algorithm) "
        "VALUES (:a, :b, :year, :count, :prior, :growth, :score, :conv, :ts, :algo)"
    )
    for i in range(0, len(rows), _INSERT_CHUNK):
        conn.execute(stmt, rows[i:i + _INSERT_CHUNK])


def _promote_converging_topics(conn, results: dict[tuple[int, int, int], ConvergenceResult]) -> int:
    """Promote 'Stable' RESEARCH_TREND rows to 'Converging' for topics in a
    converging pair; returns how many rows changed. Never touches Emerging /
    Declining rows (the WHERE clause is the whole rule). Caller owns the
    transaction."""
    best: dict[tuple[int, int], float] = {}
    for (a, b, year), r in results.items():
        if not r.is_converging:
            continue
        for topic_id in (a, b):
            key = (topic_id, year)
            if r.convergence_score > best.get(key, float("-inf")):
                best[key] = r.convergence_score
    if not best:
        return 0

    stmt = text(
        "UPDATE RESEARCH_TREND SET Trend_Label = :converging, Score = :score "
        "WHERE Topic_ID = :topic_id AND Period_Year = :year AND Trend_Label = :stable"
    )
    promoted = 0
    for (topic_id, year), score in best.items():
        res = conn.execute(stmt, {
            "converging": TREND_CONVERGING, "stable": TREND_STABLE,
            "score": score, "topic_id": topic_id, "year": year,
        })
        promoted += res.rowcount
    return promoted


def detect_and_store(*, min_relevance: float = MIN_RELEVANCE,
                     max_topics_per_paper: int = MAX_TOPICS_PER_PAPER_FOR_PAIRS,
                     dry_run: bool = False) -> dict:
    """Aggregate, classify, and (unless dry_run) persist and promote. Returns
    a JSON-safe summary; the same document is what lands in Mongo."""
    algorithm = algorithm_label()
    detected_at = datetime.now(timezone.utc)

    engine = get_engine()
    with engine.connect() as conn:
        trans = conn.begin()
        try:
            cooccurrence, papers_seen, papers_truncated = _count_cooccurrence(
                conn, min_relevance, max_topics_per_paper
            )

            results: dict[tuple[int, int, int], ConvergenceResult] = {}
            for (a, b), series in cooccurrence.items():
                for year, result in classify_pair_series(series).items():
                    results[(a, b, year)] = result

            _store_pairs(conn, results, algorithm=algorithm, detected_at=detected_at)
            topics_promoted = _promote_converging_topics(conn, results)

            if dry_run:
                trans.rollback()    # counts above are exact; nothing is kept
            else:
                trans.commit()
        except Exception:
            trans.rollback()
            raise

    converging = [(k, r) for k, r in results.items() if r.is_converging]
    latest_converging_year = max((k[2] for k, _ in converging), default=None)
    top = sorted(converging, key=lambda kr: (-kr[1].convergence_score, kr[0]))[:10]

    summary = {
        "_id": SNAPSHOT_ID,
        "detected_at": detected_at.isoformat(),
        "algorithm": algorithm,
        "params": {
            "min_relevance": min_relevance,
            "max_topics_per_paper": max_topics_per_paper,
            "converging_threshold": CONVERGING_THRESHOLD,
            "min_cooccurrence": MIN_COOCCURRENCE_FOR_TREND,
        },
        "dry_run": dry_run,
        "papers_seen": papers_seen,
        "papers_truncated": papers_truncated,
        "pairs_with_history": len(cooccurrence),
        "periods_classified": len(results),
        "converging_periods": len(converging),
        "topics_promoted": topics_promoted,
        "latest_converging_year": latest_converging_year,
        "top_pairs": [
            {"topic_a_id": a, "topic_b_id": b, "year": year,
             "cooccurrence_count": r.cooccurrence_count, "convergence_score": r.convergence_score}
            for (a, b, year), r in top
        ],
    }

    if not dry_run:
        try:
            get_mongo_db()[SNAPSHOT_COLLECTION].replace_one({"_id": SNAPSHOT_ID}, summary, upsert=True)
        except Exception:                # noqa: BLE001 - Mongo is an optional sink for this job
            log.warning("Could not persist convergence snapshot to MongoDB", exc_info=True)

    if papers_truncated:
        log.warning("%d of %d papers had more than %d topics; only the most relevant were paired",
                    papers_truncated, papers_seen, max_topics_per_paper)
    log.info(
        "Convergence%s: %d pairs with history, %d periods classified, %d converging, %d topics promoted%s",
        " (dry run)" if dry_run else "", len(cooccurrence), len(results), len(converging), topics_promoted,
        f", latest converging year {latest_converging_year}" if latest_converging_year else "",
    )
    return summary


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Detect and store converging topic pairs (F5).")
    parser.add_argument("--min-relevance", type=float, default=MIN_RELEVANCE,
                        help="PAPER_TOPIC.Relevance_Score floor for a paper to count toward a pair")
    parser.add_argument("--max-topics-per-paper", type=int, default=MAX_TOPICS_PER_PAPER_FOR_PAIRS,
                        help="Pair only each paper's N most relevant topics (quadratic-blowup guard)")
    parser.add_argument("--dry-run", action="store_true", help="Compute and log, write nothing")
    args = parser.parse_args()
    detect_and_store(min_relevance=args.min_relevance, max_topics_per_paper=args.max_topics_per_paper,
                     dry_run=args.dry_run)


if __name__ == "__main__":
    main()
