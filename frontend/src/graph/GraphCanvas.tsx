import { useEffect, useMemo, useRef, useState } from "react";
import { select } from "d3-selection";
// Side-effect import: brings in d3-selection's `.transition()` type
// augmentation (used below via d3-zoom's transform-with-transition calls).
// Pre-existing typecheck gap found while working on Phase 5 -- @types/d3-transition
// was never added as a dependency even though d3-transition itself ships
// transitively via d3-zoom.
import "d3-transition";
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from "d3-zoom";
import { buildAdjacency, edgeOpacity, type GraphEdge } from "../lib/graph";
import { useContainerWidth } from "../lib/useContainerWidth";
import { computeGraphLayout, graphLayoutSignature } from "./forceLayout";

const C = {
  ink: "var(--color-ink, #18232f)",
  ruleStrong: "var(--color-rule-strong, #b5bdc7)",
  sheet: "var(--color-sheet, #ffffff)",
  accent: "var(--color-accent, #1d4f91)",
};

interface Props<T> {
  nodes: T[];
  edges: GraphEdge[];
  /** Stable numeric id (author_id, paper_id, institution_id, ...). */
  idOf: (n: T) => number;
  /** Already-sized drawn radius (lib/graph.ts's nodeRadius). */
  radiusOf: (n: T) => number;
  colorOf: (n: T) => string;
  /** Optional ink ring, width in px, 0/undefined draws none. Doubles as
   * the bridge-score ring (Phase 5, community graph) and the citation-chain
   * emphasis ring (Phase 7): whatever a caller's node accessor returns, the
   * ring is drawn the same way -- the two never coexist on one graph. */
  ringWidthOf?: (n: T) => number;
  ariaLabelOf: (n: T) => string;
  /** Precomputed keyboard tab order (lib/graph.ts's rankedOrder /
   * tabOrder). */
  order: T[];
  /** Clustering key for layout (community_id, a color mode's bucket, ...).
   * Omit to lay out by link force alone. */
  clusterOf?: (n: T) => number | null;
  /** True when a node should read as isolated-out (dimmed); omit to never
   * dim by isolation (only hover-neighbor dimming still applies). */
  isDimmedByIsolation?: (n: T) => boolean;
  /** True when an edge should draw at full emphasis (accent stroke, no
   * weight-scaled fade) -- the citation-chain highlight from a selected
   * paper (Phase 7); omit to draw every edge at its normal weight-scaled
   * opacity. */
  isEmphasizedEdge?: (e: GraphEdge) => boolean;
  /** Edges below this weight are hidden entirely (the "minimum tie
   * strength" slider); omit to show every edge. */
  minEdgeWeight?: number;
  /** Draws an arrowhead at the target end -- a citation network's directed
   * citing -> cited edges (Phase 7); omit/false for the community graph's
   * undirected ties. */
  directed?: boolean;
  selected: number | null;
  onSelect: (id: number | null) => void;
  /** aria-live status text while hovering a node, given its direct-tie
   * count in this graph. */
  hoverStatusOf: (n: T, directTies: number) => string;
  /** aria-live status text when nothing is hovered. */
  idleStatus: string;
  /** The graph's own aria-label, given how many edges are currently
   * visible (after the minEdgeWeight filter). */
  ariaGraphLabel: (visibleEdgeCount: number) => string;
  height?: number;
}

/** The shared canvas behind every graph in design-system.md §6: d3-force
 * (graph/forceLayout.ts) for geometry, d3-zoom for the pan/zoom transform,
 * React owns every visible element. Generic over the node shape via the
 * accessor props above, so each graph type (community graph, citation
 * network, institution network) supplies its own id/size/color/isolation
 * logic instead of this component being forked per graph type -- see
 * phases.md Phase 7, "Reuse the graph engine from Phase 4; do not fork
 * it." Below ~800 nodes this renders as SVG per the design doc; every
 * current caller caps well under that (max_nodes <= 2000 with the same
 * connected-degree ranking, but typical scoped graphs are far smaller), so
 * a canvas fallback for larger graphs is not built here (see the phase
 * report). */
export default function GraphCanvas<T>({
  nodes,
  edges,
  idOf,
  radiusOf,
  colorOf,
  ringWidthOf,
  ariaLabelOf,
  order,
  clusterOf,
  isDimmedByIsolation,
  isEmphasizedEdge,
  minEdgeWeight = 0,
  directed = false,
  selected,
  onSelect,
  hoverStatusOf,
  idleStatus,
  ariaGraphLabel,
  height = 520,
}: Props<T>) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [hovered, setHovered] = useState<number | null>(null);
  const [layoutNonce, setLayoutNonce] = useState(0);

  const signature = useMemo(() => graphLayoutSignature(nodes, edges, idOf), [nodes, edges, idOf]);
  const positions = useMemo(
    () => computeGraphLayout(nodes, edges, { width: Math.max(320, width), height, idOf, sizeOf: radiusOf, clusterOf }),
    // Re-run only when the data snapshot or the viewport size actually
    // changes (or "Re-run layout" bumps the nonce) — never on a hover,
    // selection, isolate or min-edge-weight change, which are display-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, width, height, layoutNonce],
  );

  const adjacency = useMemo(() => buildAdjacency(edges), [edges]);
  const maxWeight = Math.max(1e-9, ...edges.map((e) => e.weight ?? 1));
  const visibleEdges = edges.filter((e) => (e.weight ?? 1) >= minEdgeWeight);
  const byId = new Map(nodes.map((n) => [idOf(n), n]));

  // d3-zoom owns the wheel/pinch/drag gesture math; React just mirrors its
  // transform into state so the <g> below can apply it declaratively.
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const behavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 8])
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        setTransform({ x: event.transform.x, y: event.transform.y, k: event.transform.k });
      });
    svg.call(behavior);
    zoomRef.current = behavior;
    return () => {
      svg.on(".zoom", null);
    };
  }, []);

  const zoomBy = (factor: number) => {
    if (!svgRef.current || !zoomRef.current) return;
    select(svgRef.current).transition().duration(150).call(zoomRef.current.scaleBy, factor);
  };
  const resetZoom = () => {
    if (!svgRef.current || !zoomRef.current) return;
    select(svgRef.current).transition().duration(150).call(zoomRef.current.transform, zoomIdentity);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);

  const dimmed = (id: number): boolean => {
    const node = byId.get(id);
    if (node && isDimmedByIsolation?.(node)) return true;
    if (hovered !== null) return hovered !== id && !adjacency.get(hovered)?.has(id);
    return false;
  };

  const w = Math.max(320, width);
  const markerId = "graph-arrow";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm text-muted" aria-live="polite">
          {hovered !== null && byId.has(hovered) ? hoverStatusOf(byId.get(hovered)!, adjacency.get(hovered)?.size ?? 0) : idleStatus}
        </p>
        <div className="flex shrink-0 gap-1 text-sm">
          <button type="button" onClick={() => zoomBy(1.4)} aria-label="Zoom in" className="h-7 w-7 rounded-sm border border-rule-strong bg-sheet hover:bg-accent-soft">
            +
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out" className="h-7 w-7 rounded-sm border border-rule-strong bg-sheet hover:bg-accent-soft">
            &minus;
          </button>
          <button type="button" onClick={resetZoom} className="rounded-sm border border-rule-strong bg-sheet px-2 hover:bg-accent-soft">
            Reset
          </button>
          <button type="button" onClick={() => setLayoutNonce((n) => n + 1)} className="rounded-sm border border-rule-strong bg-sheet px-2 hover:bg-accent-soft">
            Re-run layout
          </button>
        </div>
      </div>
      <div ref={wrapRef} className="w-full border border-rule-strong bg-sheet">
        <svg
          ref={svgRef}
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          role="group"
          aria-label={ariaGraphLabel(visibleEdges.length)}
          style={{ display: "block", touchAction: "none" }}
        >
          {directed && (
            <defs>
              <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 Z" fill={C.ruleStrong} />
              </marker>
            </defs>
          )}
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            <g transform={`translate(${w / 2},${height / 2})`}>
              <g aria-hidden="true">
                {visibleEdges.map((e) => {
                  const a = positions.get(e.source);
                  const b = positions.get(e.target);
                  if (!a || !b) return null;
                  const faint = dimmed(e.source) || dimmed(e.target);
                  const emphasized = isEmphasizedEdge?.(e) ?? false;
                  return (
                    <line
                      key={`${e.source}-${e.target}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={emphasized ? C.accent : C.ruleStrong}
                      strokeWidth={emphasized ? 2 : 1}
                      opacity={faint ? 0.05 : emphasized ? 0.9 : edgeOpacity(e.weight ?? 1, maxWeight)}
                      markerEnd={directed ? `url(#${markerId})` : undefined}
                    />
                  );
                })}
              </g>
              {order.map((n) => {
                const id = idOf(n);
                const p = positions.get(id);
                if (!p) return null;
                const faint = dimmed(id);
                const ring = ringWidthOf?.(n) ?? 0;
                const isSelected = selected === id;
                return (
                  <g
                    key={id}
                    transform={`translate(${p.x},${p.y})`}
                    opacity={faint ? 0.25 : 1}
                    tabIndex={0}
                    role="button"
                    aria-label={ariaLabelOf(n)}
                    onMouseEnter={() => setHovered(id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(id)}
                    onBlur={() => setHovered(null)}
                    onClick={() => onSelect(id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(id);
                      }
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    {ring > 0 && <circle r={p.r + ring + 1.5} fill="none" stroke={C.ink} strokeWidth={ring} />}
                    <circle r={p.r} fill={colorOf(n)} stroke={isSelected ? C.accent : C.sheet} strokeWidth={isSelected ? 2.5 : 1} />
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}
