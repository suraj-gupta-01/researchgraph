/**
 * Pure helpers shared by every graph in design-system.md §6's grammar --
 * community graph (Phase 4, G1), citation network (Phase 7, G2) and
 * institution network (Phase 7, G5). Nothing here touches the DOM or React;
 * layout itself lives in graph/forceLayout.ts (it needs d3-force but is
 * still a pure function of its inputs). Each generic helper below is
 * followed by its Phase-4 community-graph instantiation, kept as its own
 * function so that phase's existing callers and tests are unaffected;
 * later graph types call the generic helper directly with their own
 * accessors, per "reuse the graph engine, do not fork it" (phases.md
 * Phase 7). Contract source: references/design-system.md §6 "Graph
 * grammar".
 */
import type { CommunityGraphEdge, CommunityGraphNode } from "../api/communities";

/** The minimal edge shape every graph type in design-system.md §6 shares --
 * source/target ids and an optional weight (a citation edge has none, so it
 * reads as uniform weight 1 wherever weight-scaled drawing is used). Every
 * generated *GraphEdge type (CommunityGraphEdge, CitationNetworkEdge, ...)
 * satisfies this structurally, so the shared helpers below take it directly
 * instead of being re-typed per graph. */
export interface GraphEdge {
  source: number;
  target: number;
  weight?: number;
}

// Literal fallbacks alongside the CSS custom properties, same reasoning as
// TREND_COLOR_VAR: an exported .svg has no stylesheet.
export const COMMUNITY_PALETTE = [
  "var(--color-community-1, #0072b2)",
  "var(--color-community-2, #d55e00)",
  "var(--color-community-3, #009e73)",
  "var(--color-community-4, #cc79a7)",
  "var(--color-community-5, #e69f00)",
  "var(--color-community-6, #56b4e9)",
  "var(--color-community-7, #8b6f47)",
  "var(--color-community-8, #5f5aa2)",
];
export const COMMUNITY_NONE_COLOR = "var(--color-community-none, #b5bdc7)";
export const MAX_COLORED_COMMUNITIES = COMMUNITY_PALETTE.length;

export interface LegendEntry {
  /** The category key (community_id, a color-mode's bucket, ...); null =
   * the item has no category (design-system.md: "Unassigned authors are
   * grey" -- generalized to any graph type's "no category" case). Named
   * communityId for the Phase-4 community graph, its first caller; kept as
   * one shared field rather than renamed per graph type. */
  communityId: number | null;
  /** null only for the synthetic "Other" bucket entry. */
  label: string | null;
  color: string;
  memberCount: number;
  /** True for the bucket standing in for every community past the 8th. */
  isOther: boolean;
}

/** Assigns the 8-color categorical palette to the largest categories among
 * the given items (by count in THIS graph, not a corpus-wide total, so the
 * legend matches what's actually drawn); categories past the 8th share one
 * grey "Other" bucket, and items with no category (null) are always grey --
 * never mixed into the numbered palette (design-system.md §2: "Beyond eight
 * communities, keep the eight largest colored and group the rest... Do not
 * mix the community categories with trend semantics", and by the same
 * logic, not with the none color). Shared by every graph type's legend
 * (community, year-or-community citation network, country institution
 * network); `buildLegend` below is the Phase-4 community-graph
 * instantiation, kept as its own function so existing callers/tests are
 * unaffected. */
export function buildCategoricalLegend<T>(
  items: T[],
  keyOf: (item: T) => number | null,
  labelOf: (key: number) => string,
  opts: { noneLabel?: string; otherLabel?: string } = {},
): { legend: LegendEntry[]; colorOf: (key: number | null) => string } {
  const { noneLabel = "Unassigned", otherLabel = "Other" } = opts;
  const counts = new Map<number, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Ties by key, so equal-sized groups get the same colour whatever order
  // the API returned rows in (and the same colour on every page).
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const colored = ranked.slice(0, MAX_COLORED_COMMUNITIES);
  const colorMap = new Map<number, string>(colored.map(([id], i) => [id, COMMUNITY_PALETTE[i]]));
  const otherCount = ranked.slice(MAX_COLORED_COMMUNITIES).reduce((sum, [, n]) => sum + n, 0);
  const noneCount = items.filter((item) => keyOf(item) === null).length;

  const legend: LegendEntry[] = colored.map(([id, count]) => ({
    communityId: id,
    label: labelOf(id),
    color: colorMap.get(id)!,
    memberCount: count,
    isOther: false,
  }));
  if (otherCount > 0) {
    legend.push({ communityId: null, label: otherLabel, color: COMMUNITY_NONE_COLOR, memberCount: otherCount, isOther: true });
  }
  if (noneCount > 0) {
    legend.push({ communityId: null, label: noneLabel, color: COMMUNITY_NONE_COLOR, memberCount: noneCount, isOther: false });
  }

  const colorOf = (key: number | null) => (key !== null ? (colorMap.get(key) ?? COMMUNITY_NONE_COLOR) : COMMUNITY_NONE_COLOR);
  return { legend, colorOf };
}

/** buildCategoricalLegend keyed by community_id, labeled "Other
 * communities" / "Unassigned" -- the Phase-4 community-graph legend. */
export function buildLegend(nodes: CommunityGraphNode[], labelById: Map<number, string>): { legend: LegendEntry[]; colorOf: (communityId: number | null) => string } {
  return buildCategoricalLegend(
    nodes,
    (n) => n.community_id,
    (id) => labelById.get(id) ?? `Community ${id}`,
    { noneLabel: "Unassigned", otherLabel: "Other communities" },
  );
}

/** sqrt(paper_count), scaled to 4-16 px (design-system.md §6). A paper count
 * of 0 still draws at the floor, never a zero-size (invisible) node. */
export function nodeRadius(paperCount: number, maxPaperCount: number): number {
  const MIN_R = 4;
  const MAX_R = 16;
  if (maxPaperCount <= 0) return MIN_R;
  const t = Math.sqrt(Math.max(0, paperCount)) / Math.sqrt(maxPaperCount);
  return MIN_R + t * (MAX_R - MIN_R);
}

/** Ring width for a bridge researcher; 0 draws no ring at all. bridge_score
 * is a 0..1 participation coefficient (graph/influence_core.py), so this
 * saturates at a small, readable stroke rather than growing unbounded. */
export function bridgeRingWidth(bridgeScore: number | null): number {
  if (!bridgeScore || bridgeScore <= 0) return 0;
  return 1 + Math.min(1, bridgeScore) * 2.5;
}

/** Edge opacity scaled by weight against the heaviest edge in the graph, so
 * the strongest tie is always fully opaque regardless of the corpus. */
export function edgeOpacity(weight: number, maxWeight: number): number {
  if (maxWeight <= 0) return 0.15;
  return 0.12 + 0.68 * Math.min(1, weight / maxWeight);
}

/** node id -> the set of directly-tied node ids, for hover-dims-non-
 * neighbors (design-system.md §6). Generic over GraphEdge so every graph
 * type shares this, not just the community graph. */
export function buildAdjacency(edges: GraphEdge[]): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  return adj;
}

/** Tab order the design calls for: legend rank first (items with no
 * category last), then weighted degree within it, both descending. Shared
 * engine behind every graph type's keyboard order; `tabOrder` below is the
 * Phase-4 community-graph instantiation, kept as its own function so
 * existing callers/tests are unaffected. */
export function rankedOrder<T>(nodes: T[], edges: GraphEdge[], idOf: (n: T) => number, categoryOf: (n: T) => number | null, legendRank: Map<number, number>): T[] {
  const degree = new Map<number, number>();
  for (const e of edges) {
    const w = e.weight ?? 1;
    degree.set(e.source, (degree.get(e.source) ?? 0) + w);
    degree.set(e.target, (degree.get(e.target) ?? 0) + w);
  }
  const rank = (n: T) => {
    const key = categoryOf(n);
    return key !== null ? (legendRank.get(key) ?? 999) : 1000;
  };
  return [...nodes].sort((a, b) => rank(a) - rank(b) || (degree.get(idOf(b)) ?? 0) - (degree.get(idOf(a)) ?? 0));
}

/** rankedOrder keyed by author_id/community_id -- the Phase-4 community
 * graph's tab order. */
export function tabOrder(nodes: CommunityGraphNode[], edges: CommunityGraphEdge[], legendRank: Map<number, number>): CommunityGraphNode[] {
  return rankedOrder(nodes, edges, (n) => n.author_id, (n) => n.community_id, legendRank);
}

export type IsolationKey = number | "other" | "unassigned" | null;

/** Whether an item belongs to the legend entry the viewer clicked to
 * isolate. "other" is every colored-out category past the top 8 (still a
 * real key, just not one with its own palette slot); "unassigned" is
 * categoryOf(item) === null; null means nothing is isolated, so everything
 * matches. Shared engine behind every graph type's isolation; `matchesIsolation`
 * below is the Phase-4 community-graph instantiation, kept as its own
 * function so existing callers/tests are unaffected. */
export function matchesCategory<T>(item: T, isolated: IsolationKey, categoryOf: (n: T) => number | null, colorOf: (key: number | null) => string): boolean {
  const key = categoryOf(item);
  if (isolated === null) return true;
  if (isolated === "unassigned") return key === null;
  if (isolated === "other") return key !== null && colorOf(key) === COMMUNITY_NONE_COLOR;
  return key === isolated;
}

/** matchesCategory keyed by community_id -- the Phase-4 community graph's
 * isolation check. */
export function matchesIsolation(node: CommunityGraphNode, isolated: IsolationKey, colorOf: (communityId: number | null) => string): boolean {
  return matchesCategory(node, isolated, (n) => n.community_id, colorOf);
}

/** Clamps a zoom scale factor to a sane interactive range. */
export function clampZoom(k: number): number {
  return Math.min(8, Math.max(0.2, k));
}
