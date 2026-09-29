"""
M4 — Part 2: Emerging topic detection (PRD F3).

Aggregates PAPER_TOPIC/PAPER/AUTHORSHIP/PAPER_AUTHOR_INSTITUTION into one
TOPIC_SNAPSHOT row per (topic, year) actually observed in the corpus, then
classifies each of those periods into RESEARCH_TREND via graph.trend_core.
The formula and thresholds live there (pure, unit-testable); this module is
the I/O and the aggregation query around them — same split as M4 Part 1
(graph.community_core / graph.communities).

    docker compose exec backend python -m graph.trends
    docker compose exec backend python -m graph.trends --dry-run

A topic only gets a TOPIC_SNAPSHOT row for a year it has >= 1 paper tagged
on it (above the relevance floor below) in the corpus — there is nothing to
aggregate for a year it wasn't tagged in, so no row is written; a topic that
goes fully dormant simply stops appearing rather than getting a "0 papers"
row. Documented under README "Known limits" as it affects how a chart built
straight off TOPIC_SNAPSHOT should render gaps.

Run semantics mirror graph.communities (PRD Section 8, auditability):
  * A run REPLACES the previous run's rows in both tables: TOPIC_SNAPSHOT
    is fully recomputed (DELETE + reinsert) so a topic/paper that was
    re-scored or removed doesn't leave a stale row behind, and
    RESEARCH_TREND rows sharing this run's Algorithm prefix are replaced the
    same way. RESEARCH_TREND rows with a different Algorithm prefix — F5's
    future 'Converging' rows — are left untouched.
  * Growth_Rate is computed from THIS run's in-memory year series per topic,
    not by reading back TOPIC_SNAPSHOT mid-run, so the numbers in one run
    are internally consistent regardless of insert order.
  * The whole replace is one transaction per table pair: a failure leaves
    the previous run in place.
  * The run is also written to MongoDB (`graph_snapshot`, `_id: "trends"`,
    PRD 6.4's "graph-analysis result blobs"): parameters and label counts.
    If Mongo is down the run still succeeds.

Precondition: topic extraction (M3 Part 1) has run. Without PAPER_TOPIC rows
this produces an empty result, not an error.
"""
from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone

from sqlalchemy import text

from app.db import get_engine, get_mongo_db
from graph.build_graph import SHARED_TOPIC_MIN_RELEVANCE
from graph.trend_core import (
    ALGORITHM_NAME,
    TREND_DECLINING,
    TREND_EMERGING,
    TREND_STABLE,
    TrendResult,
    algorithm_label,
    classify_series,
)

log = logging.getLogger("researchgraph.trends")

SNAPSHOT_COLLECTION = "graph_snapshot"
SNAPSHOT_ID = "trends"

# Same floor graph.communities uses for shared-topic edges and label
# evidence: a paper only counts toward a topic's snapshot if extraction
# scored it at least this relevant, so a chart built off TOPIC_SNAPSHOT and
# a community label built off PAPER_TOPIC agree on what counts as "this
# paper is about that topic".
MIN_RELEVANCE = SHARED_TOPIC_MIN_RELEVANCE

_AGGREGATE_SQL = """
WITH topic_papers AS (
    SELECT pt.Topic_ID, p.Paper_ID, p.Publication_Year AS year, p.Citation_Count
    FROM PAPER_TOPIC pt
    JOIN PAPER p ON p.Paper_ID = pt.Paper_ID
    WHERE pt.Relevance_Score >= :min_rel
),
base AS (
    SELECT Topic_ID, year, COUNT(*) AS paper_count, COALESCE(SUM(Citation_Count), 0) AS citation_count
    FROM topic_papers
    GROUP BY Topic_ID, year
),
authors AS (
    SELECT tp.Topic_ID, tp.year, COUNT(DISTINCT s.Author_ID) AS author_count
    FROM topic_papers tp JOIN AUTHORSHIP s ON s.Paper_ID = tp.Paper_ID
    GROUP BY tp.Topic_ID, tp.year
),
institutions AS (
    SELECT tp.Topic_ID, tp.year, COUNT(DISTINCT vi.Institution_ID) AS institution_count
    FROM topic_papers tp JOIN v_paper_institution vi ON vi.Paper_ID = tp.Paper_ID
    GROUP BY tp.Topic_ID, tp.year
)
SELECT b.Topic_ID AS topic_id, b.year AS year, b.paper_count AS paper_count,
       b.citation_count AS citation_count,
       COALESCE(a.author_count, 0) AS author_count,
       COALESCE(i.institution_count, 0) AS institution_count
FROM base b
LEFT JOIN authors a ON a.Topic_ID = b.Topic_ID AND a.year = b.year
LEFT JOIN institutions i ON i.Topic_ID = b.Topic_ID AND i.year = b.year
"""


def _fetch_aggregates(conn, min_relevance: float) -> list[dict]:
    """One row per (topic, year) with >= 1 paper above the relevance floor.
    Also PRD Section 9's demo aggregation query ("Publication_Year ->
    COUNT(*) per topic"), run live rather than pre-materialized."""
    rows = conn.execute(text(_AGGREGATE_SQL), {"min_rel": min_relevance}).mappings().all()
    return [dict(r) for r in rows]


def _store(conn, aggregates: list[dict], trends: dict[tuple[int, int], TrendResult],
           *, algorithm: str, detected_at: datetime) -> None:
    """Replace the previous run's rows in both tables. Caller owns the transaction."""
    conn.execute(text("DELETE FROM TOPIC_SNAPSHOT"))
    conn.execute(text("DELETE FROM RESEARCH_TREND WHERE Algorithm LIKE :prefix"), {"prefix": ALGORITHM_NAME + "%"})

    if not aggregates:
        return

    conn.execute(
        text(
            "INSERT INTO TOPIC_SNAPSHOT "
            "(Topic_ID, Snapshot_Year, Paper_Count, Author_Count, Institution_Count, Citation_Count, Growth_Rate) "
            "VALUES (:topic_id, :year, :paper_count, :author_count, :institution_count, :citation_count, :growth_rate)"
        ),
        [
            {**row, "growth_rate": trends[(row["topic_id"], row["year"])].growth_rate}
            for row in aggregates
        ],
    )
    conn.execute(
        text(
            "INSERT INTO RESEARCH_TREND (Topic_ID, Period_Year, Trend_Label, Score, Detection_Date, Algorithm) "
            "VALUES (:topic_id, :year, :label, :score, :ts, :algo)"
        ),
        [
            {
                "topic_id": tid, "year": year, "label": tr.trend_label, "score": tr.score,
                "ts": detected_at, "algo": algorithm,
            }
            for (tid, year), tr in trends.items()
        ],
    )


def detect_and_store(*, min_relevance: float = MIN_RELEVANCE, dry_run: bool = False) -> dict:
    """Aggregate, classify and (unless dry_run) persist. Returns a JSON-safe
    summary; the same document is what lands in Mongo."""
    algorithm = algorithm_label()
    detected_at = datetime.now(timezone.utc)

    engine = get_engine()
    with (engine.connect() if dry_run else engine.begin()) as conn:
        aggregates = _fetch_aggregates(conn, min_relevance)

        by_topic: dict[int, dict[int, int]] = {}
        for row in aggregates:
            by_topic.setdefault(row["topic_id"], {})[row["year"]] = row["paper_count"]

        trends: dict[tuple[int, int], TrendResult] = {}
        for topic_id, series in by_topic.items():
            for year, result in classify_series(series).items():
                trends[(topic_id, year)] = result

        if not dry_run:
            _store(conn, aggregates, trends, algorithm=algorithm, detected_at=detected_at)

    label_counts = {TREND_EMERGING: 0, TREND_STABLE: 0, TREND_DECLINING: 0}
    for tr in trends.values():
        label_counts[tr.trend_label] += 1

    latest_year = max((row["year"] for row in aggregates), default=None)
    summary = {
        "_id": SNAPSHOT_ID,
        "detected_at": detected_at.isoformat(),
        "algorithm": algorithm,
        "params": {"min_relevance": min_relevance},
        "dry_run": dry_run,
        "topics_with_snapshots": len(by_topic),
        "periods_classified": len(trends),
        "latest_year": latest_year,
        "label_counts": label_counts,
    }

    if not dry_run:
        try:
            get_mongo_db()[SNAPSHOT_COLLECTION].replace_one({"_id": SNAPSHOT_ID}, summary, upsert=True)
        except Exception:                # noqa: BLE001 - Mongo is an optional sink for this job
            log.warning("Could not persist trend snapshot to MongoDB", exc_info=True)

    log.info(
        "Trends%s: %d topics, %d periods classified (%s)%s",
        " (dry run)" if dry_run else "", len(by_topic), len(trends), label_counts,
        f", latest year {latest_year}" if latest_year else "",
    )
    return summary


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Detect and store emerging/declining topic trends (F3).")
    parser.add_argument("--min-relevance", type=float, default=MIN_RELEVANCE,
                        help="PAPER_TOPIC.Relevance_Score floor for a paper to count toward a topic's snapshot")
    parser.add_argument("--dry-run", action="store_true", help="Compute and log, write nothing")
    args = parser.parse_args()
    detect_and_store(min_relevance=args.min_relevance, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
