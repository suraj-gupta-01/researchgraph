/**
 * Layout only. design-system.md §6: "d3-force... used for geometry and
 * interaction only; React renders the SVG." This module never touches the
 * DOM, so it is a pure function of (nodes, edges) and unit-testable without
 * a browser. Positions are computed once and frozen (`simulation.stop()`
 * after a fixed number of ticks), not animated per frame, and the caller is
 * responsible for re-running it only when the data snapshot actually
 * changes ("positions cached per data snapshot").
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from "d3-force";
import type { CommunityGraphEdge, CommunityGraphNode } from "../api/communities";
import type { GraphEdge } from "../lib/graph";
import { nodeRadius } from "../lib/graph";

export interface LaidOutNode {
  id: number;
  x: number;
  y: number;
  r: number;
  communityId: number | null;
}

interface SimNode extends SimulationNodeDatum {
  id: number;
  r: number;
  clusterKey: number; // clusterOf(node), or a synthetic bucket when it returns null
}

const NO_CLUSTER = -1;

/** Nudges every node toward its cluster's current centroid each tick — the
 * standard "cluster force" (not shipped by d3-force itself). Pure and
 * self-contained: it only reads/writes the node objects passed to it.
 * Exported (only) so forceLayout.test.ts can exercise the clustering math
 * directly, without needing a real d3-force simulation loop around it. */
export function forceCluster(strength: number) {
  let nodes: SimNode[] = [];
  function force(alpha: number) {
    const sums = new Map<number, { x: number; y: number; n: number }>();
    for (const node of nodes) {
      const s = sums.get(node.clusterKey) ?? { x: 0, y: 0, n: 0 };
      s.x += node.x ?? 0;
      s.y += node.y ?? 0;
      s.n += 1;
      sums.set(node.clusterKey, s);
    }
    for (const node of nodes) {
      const s = sums.get(node.clusterKey)!;
      const cx = s.x / s.n;
      const cy = s.y / s.n;
      node.vx = (node.vx ?? 0) - (( node.x ?? 0) - cx) * strength * alpha;
      node.vy = (node.vy ?? 0) - ((node.y ?? 0) - cy) * strength * alpha;
    }
  }
  force.initialize = (n: SimNode[]) => {
    nodes = n;
  };
  return force;
}

/** Deterministic starting positions (a golden-angle spiral by index), so two
 * layouts of the same data snapshot land the same way instead of depending
 * on d3-force's internal Math.random seeding. */
function seedPositions(n: number, spread: number): { x: number; y: number }[] {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const r = spread * Math.sqrt((i + 0.5) / n);
    const theta = i * GOLDEN_ANGLE;
    return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
  });
}

export interface LayoutOptions {
  width: number;
  height: number;
  ticks?: number;
  clusterStrength?: number;
}

export interface LayoutAccessors<T> {
  /** Stable numeric id (author_id, paper_id, institution_id, ...). */
  idOf: (n: T) => number;
  /** Already-sized drawn radius (nodeRadius), reused here so the collision
   * force keeps circles from overlapping at their drawn size. */
  sizeOf: (n: T) => number;
  /** A clustering key nodes get pulled toward each other by (community_id,
   * a color mode's bucket, ...). Omit to skip the cluster force entirely --
   * plain force-directed-by-links is often the more legible layout for a
   * graph with no natural cluster signal (e.g. a citation network colored
   * by year). */
  clusterOf?: (n: T) => number | null;
}

/** The shared simulation engine behind every graph in design-system.md §6
 * (community graph, citation network, institution network): d3-force for
 * geometry, frozen after a fixed number of ticks, never re-run except on a
 * genuine data-snapshot or viewport change. Generic over the node shape so
 * each graph type supplies its own id/size/cluster accessors instead of
 * this module (or its caller) forking a second copy of the physics setup --
 * see phases.md Phase 7, "Reuse the graph engine from Phase 4; do not fork
 * it." `computeLayout` below is the Phase-4 community-graph instantiation
 * of this, kept as its own function so existing callers and tests are
 * unaffected. */
export function computeGraphLayout<T>(nodes: T[], edges: GraphEdge[], opts: LayoutOptions & LayoutAccessors<T>): Map<number, LaidOutNode> {
  if (nodes.length === 0) return new Map();
  const { width, height, ticks = 300, clusterStrength = 0.25, idOf, sizeOf, clusterOf } = opts;
  const spread = Math.max(width, height) * 0.6;
  const seeds = seedPositions(nodes.length, spread);

  const simNodes: SimNode[] = nodes.map((n, i) => ({
    id: idOf(n),
    r: sizeOf(n),
    clusterKey: clusterOf ? (clusterOf(n) ?? NO_CLUSTER) : NO_CLUSTER,
    x: seeds[i].x,
    y: seeds[i].y,
  }));
  const byId = new Map(simNodes.map((n) => [n.id, n]));
  const links = edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, weight: e.weight ?? 1 }));

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(links)
        .id((d: SimulationNodeDatum) => (d as SimNode).id)
        .distance(40)
        .strength((l: { weight: number }) => Math.min(1, l.weight / 4)),
    )
    .force("charge", forceManyBody().strength(-120))
    .force("collide", forceCollide<SimNode>().radius((d: SimNode) => d.r + 2))
    .force("center", forceCenter(0, 0));
  if (clusterOf) sim.force("cluster", forceCluster(clusterStrength));
  sim.stop();

  for (let i = 0; i < ticks; i++) sim.tick();

  const out = new Map<number, LaidOutNode>();
  for (const n of simNodes) {
    out.set(n.id, { id: n.id, x: n.x ?? 0, y: n.y ?? 0, r: n.r, communityId: n.clusterKey === NO_CLUSTER ? null : n.clusterKey });
  }
  return out;
}

/** A stable key for "is this the same data snapshot", so the caller only
 * recomputes layout when nodes or edges actually change, not on every
 * render (e.g. a min-tie-strength slider, which only hides edges, should
 * not reshuffle the graph). Shared across graph types the same way
 * computeGraphLayout is; see its doc comment. */
export function graphLayoutSignature<T>(nodes: T[], edges: GraphEdge[], idOf: (n: T) => number): string {
  const n = nodes.map(idOf).join(",");
  const e = edges.map((x) => `${x.source}-${x.target}`).join(",");
  return `${n}|${e}`;
}

/** Computes and freezes node positions for the community graph (Phase 4,
 * G1) specifically -- author_id, paper_count-sized radius, clustered by
 * community_id. Thin instantiation of computeGraphLayout; see its doc
 * comment for the shared engine other graph types (Phase 7) build on. */
export function computeLayout(nodes: CommunityGraphNode[], edges: CommunityGraphEdge[], opts: LayoutOptions): Map<number, LaidOutNode> {
  const maxPapers = Math.max(1, ...nodes.map((n) => n.paper_count));
  return computeGraphLayout(nodes, edges, {
    ...opts,
    idOf: (n) => n.author_id,
    sizeOf: (n) => nodeRadius(n.paper_count, maxPapers),
    clusterOf: (n) => n.community_id,
  });
}

export function layoutSignature(nodes: CommunityGraphNode[], edges: CommunityGraphEdge[]): string {
  return graphLayoutSignature(nodes, edges, (n) => n.author_id);
}
