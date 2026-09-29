import type { ApiError } from "../api/client";

/**
 * Pure helpers for the F4 influence profile (Phase 5a). Kept separate from
 * the fetching component (features/authors/InfluencePanel.tsx) so the
 * "two distinct 404s" split and the metric-range decision are unit-tested
 * without a DOM. Contract source: references/phases.md Phase 5,
 * references/api-coverage.md §2-3.
 */

/**
 * Degree, betweenness and PageRank (graph/influence_core.py) are each
 * normalized 0..1 by construction -- NetworkX's own definitions, per the
 * backend README's centrality notes -- so MetricBar can bar every one of
 * them against this fixed mathematical range without an extra corpus-wide
 * fetch. This is a documented simplification: it positions a metric
 * against its own theoretical range, not against today's live distribution
 * of every other author. The Bridge researchers board (Phase 5b) is where
 * many authors' rows sit side by side for that kind of comparison; the
 * single-author panel here trades that away for one clean request.
 */
export const METRIC_RANGE = 1;

export const METRIC_EXPLANATION = {
  degree: "How many other researchers this author has a direct tie to, out of everyone in the collaboration graph.",
  betweenness: "How often this author sits on the shortest collaboration path between two other researchers.",
  pagerank: "How much collaboration \u201cweight\u201d flows to this author from the rest of the graph.",
  bridge: "How evenly this author's ties spread across detected communities \u2014 0 means every tie sits in one community.",
} as const;

/**
 * The influence endpoint has two distinct 404s (backend/app/routers/authors.py
 * `author_influence`): a missing author, and one that exists but hasn't
 * been scored by `graph.influence` yet. Distinguish by the FastAPI detail
 * text rather than guessing from status alone, since both are plain 404s.
 */
export function isUnscored(error: ApiError): boolean {
  const body = error.detail as { detail?: string } | undefined;
  const detail = body?.detail;
  return typeof detail === "string" && detail.toLowerCase().includes("graph.influence run");
}

/**
 * communities_touched of 0 with a bridge_score of 0 means "no ties into
 * any detected community" -- e.g. the author only appears in the
 * demo-scoped citation graph, not the collaboration graph Louvain ran on --
 * not "this author has low influence overall". Surfaced as a one-line
 * caveat rather than silently rendering a zero bar, per api-coverage.md §3.
 */
export function isUntouched(communitiesTouched: number, bridgeScore: number): boolean {
  return communitiesTouched === 0 && bridgeScore === 0;
}
