"""
CLI entrypoint for M1's demo dataset load.

Usage (inside the backend container, or locally with the env vars set):
    python -m ingestion.run_ingestion --topic "federated learning" --limit 200
    python -m ingestion.run_ingestion --topic "federated learning" --limit 200 --source openalex

Per the PRD's scoping advice (Section 11): keep the demo dataset to a
handful of topics (e.g. Federated Learning + 2-3 adjacent areas) rather than
attempting the full research ecosystem.
"""
from __future__ import annotations

import argparse
import logging

from graph.build_graph import build_and_summarize
from graph.communities import detect_and_store as detect_communities
from graph.convergence import detect_and_store as detect_convergence
from graph.influence import detect_and_store as detect_influence
from graph.trends import detect_and_store as detect_trends
from ingestion import openalex_adapter, semantic_scholar_adapter
from ingestion.derive_collaboration import derive_collaboration
from ingestion.extract_topics import extract_topics
from ingestion.loader import link_citations, load_papers
from ingestion.validate_provenance import run_validation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("researchgraph.run_ingestion")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest papers for a topic from OpenAlex and/or Semantic Scholar.")
    parser.add_argument("--topic", required=True, help="Free-text topic query, e.g. 'federated learning'")
    parser.add_argument("--limit", type=int, default=200, help="Max papers per source")
    parser.add_argument(
        "--source", choices=["both", "openalex", "semantic_scholar"], default="both",
        help="Restrict to a single source, e.g. while iterating on one adapter",
    )
    args = parser.parse_args()

    all_papers = []

    if args.source in ("both", "openalex"):
        log.info("Fetching from OpenAlex: topic=%r limit=%d", args.topic, args.limit)
        oa_papers = openalex_adapter.fetch_and_normalize(args.topic, args.limit)
        log.info("OpenAlex returned %d papers", len(oa_papers))
        all_papers.extend(oa_papers)

    if args.source in ("both", "semantic_scholar"):
        log.info("Fetching from Semantic Scholar: topic=%r limit=%d", args.topic, args.limit)
        ss_papers = semantic_scholar_adapter.fetch_and_normalize(args.topic, args.limit)
        log.info("Semantic Scholar returned %d papers", len(ss_papers))
        all_papers.extend(ss_papers)

    log.info("Loading %d total normalized papers into Postgres/MongoDB", len(all_papers))
    stats = load_papers(all_papers)
    log.info("Load stats: %s", stats)

    log.info("Linking citations (second pass, needs full batch loaded first)")
    linked = link_citations(all_papers)
    log.info("Linked %d citation edges", linked)

    log.info("Deriving institution collaboration pairs")
    derive_collaboration()

    log.info("Extracting topics (source keywords + TF-IDF)")
    log.info("Topic extraction stats: %s", extract_topics())

    log.info("Building the Author-Paper-Institution-Topic-Venue-Citation graph")
    log.info("Graph construction summary: %s", build_and_summarize())

    log.info("Detecting research communities (Louvain)")
    community_run = detect_communities()
    log.info("Communities: %d kept, labels: %s", community_run["communities_kept"],
             [c["label"] for c in community_run["communities"]])

    log.info("Detecting emerging/declining topic trends")
    trend_run = detect_trends()
    log.info("Trends: %d topics, %d periods classified (%s)", trend_run["topics_with_snapshots"],
             trend_run["periods_classified"], trend_run["label_counts"])

    log.info("Detecting converging topic pairs")
    convergence_run = detect_convergence()
    log.info("Convergence: %d pairs with history, %d converging, %d topics promoted",
              convergence_run["pairs_with_history"], convergence_run["converging_periods"],
              convergence_run["topics_promoted"])

    log.info("Computing researcher influence & bridge scores")
    influence_run = detect_influence()
    log.info("Influence: %d authors scored, %d bridge researchers", influence_run["authors_scored"],
             influence_run["bridge_researchers_found"])

    log.info("Validating provenance / cross-source merges")
    report = run_validation()
    if not report["ok"]:
        log.error("Provenance validation FAILED - see the [fail] lines above before trusting this dataset")


if __name__ == "__main__":
    main()
