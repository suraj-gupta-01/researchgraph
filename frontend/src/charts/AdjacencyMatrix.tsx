import { useMemo, useState, type KeyboardEvent } from "react";
import ScrollRegion from "../components/ScrollRegion";
import { useContainerWidth } from "../lib/useContainerWidth";

/** One row/column of the matrix, already in display order. */
export interface MatrixNode {
  id: number;
  label: string;
  /** Group color (country, community): the chip beside the label. */
  color: string;
  /** Consecutive rows sharing a group get a block outline when `blocks` is on. */
  group: number | null;
  /** Faded by legend isolation. */
  dimmed?: boolean;
  /** Optional 0..1 marker drawn as a small bar beside the label (bridge score). */
  marker?: number | null;
}

export interface MatrixEdge {
  source: number;
  target: number;
  weight: number;
}

interface Props {
  nodes: MatrixNode[];
  edges: MatrixEdge[];
  /** "shared papers", "tie strength": used in the status line and legend. */
  weightName: string;
  formatWeight: (w: number) => string;
  /** Print the weight inside cells that are big enough (integer weights). */
  showValues?: boolean;
  /** Outline each run of same-group rows along the diagonal (communities). */
  blocks?: boolean;
  /** Cells below this weight are left empty (the "minimum tie strength" control). */
  minWeight?: number;
  /** Emphasised row/column, e.g. the ego network's own institution. */
  highlightId?: number | null;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  markerName?: string;
  ariaLabel: string;
  idleStatus: string;
}

// The design system's sequential ramp (same endpoints as the convergence
// matrix): pale for weak ties, the frontend's accent blue for the strongest.
const RAMP_FROM = [0xe3, 0xec, 0xf7];
const RAMP_TO = [0x1d, 0x4f, 0x91];
const C = {
  ink: "var(--color-ink, #18232f)",
  muted: "var(--color-muted, #55626f)",
  ruleStrong: "var(--color-rule-strong, #b5bdc7)",
  grid: "#eef1f4",
  empty: "var(--color-sheet, #ffffff)",
  accent: "var(--color-accent, #1d4f91)",
  bar: "var(--color-bar, #b9c1cf)",
};

/** sqrt spreads the low end, where most ties sit, without letting one
 * outlier wash every other cell out; the exact value is in the status line. */
export function shade(weight: number, max: number): number {
  if (!(max > 0) || !(weight > 0)) return 0;
  return Math.min(1, Math.sqrt(weight / max));
}

export function rampColor(t: number): string {
  const c = RAMP_FROM.map((f, i) => Math.round(f + (RAMP_TO[i] - f) * Math.max(0, Math.min(1, t))));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Runs of consecutive nodes in the same (non-null) group: [start, end) indices. */
export function groupRuns(nodes: Pick<MatrixNode, "group">[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = 0;
  for (let i = 1; i <= nodes.length; i++) {
    if (i === nodes.length || nodes[i].group !== nodes[start].group) {
      if (nodes[start].group !== null && i - start > 1) runs.push([start, i]);
      start = i;
    }
  }
  return runs;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** A weighted adjacency matrix: the replacement for force-directed drawings
 * of near-complete graphs (the institution network and the author
 * collaboration graph are ~100% dense on this corpus, where a node-link
 * drawing collapses into an overlapping blob with every edge hidden).
 * Every pair has its own cell, so nothing overlaps and tie strength is read
 * straight off the shade. Rows are the keyboard stops: each label is a
 * button (Enter/Space selects); the list view is the non-visual alternative. */
export default function AdjacencyMatrix({
  nodes,
  edges,
  weightName,
  formatWeight,
  showValues = false,
  blocks = false,
  minWeight = 0,
  highlightId = null,
  selectedId = null,
  onSelect,
  markerName,
  ariaLabel,
  idleStatus,
}: Props) {
  const [ref, width] = useContainerWidth<HTMLDivElement>(800);
  const [hover, setHover] = useState<{ row: number; col: number | null } | null>(null);

  const n = nodes.length;
  const narrow = width < 600;
  const labelChars = narrow ? 14 : 26;
  const hasMarker = nodes.some((d) => d.marker != null);
  const MARK = hasMarker ? 30 : 0;
  const LEFT = (narrow ? 104 : 184) + MARK;
  const TOP = narrow ? 104 : 150;
  // Column labels slant up and to the right (-60deg), so the last ones need
  // room past the grid's right edge or they are clipped.
  const RIGHT = narrow ? 56 : 84;
  const cell = Math.max(12, Math.min(40, Math.floor((width - LEFT - RIGHT) / Math.max(1, n))));
  const gridW = n * cell;
  const svgW = LEFT + gridW + RIGHT;
  const svgH = TOP + gridW + 52;
  const clip = (s: string) => (s.length > labelChars ? `${s.slice(0, labelChars - 1)}…` : s);

  const weightOf = useMemo(() => new Map(edges.map((e) => [pairKey(e.source, e.target), e.weight])), [edges]);
  const max = Math.max(0, ...edges.map((e) => e.weight));
  const w = (a: number, b: number) => weightOf.get(pairKey(a, b)) ?? 0;

  const status = (() => {
    if (!hover) return idleStatus;
    const r = nodes[hover.row];
    if (hover.col !== null) {
      const c = nodes[hover.col];
      if (r.id === c.id) return r.label;
      const v = w(r.id, c.id);
      return `${r.label} ↔ ${c.label}: ${v > 0 ? `${formatWeight(v)} ${weightName}` : `no ${weightName}`}`;
    }
    const ties = nodes.filter((o) => o.id !== r.id && w(r.id, o.id) > 0);
    const best = ties.sort((a, b) => w(r.id, b.id) - w(r.id, a.id))[0];
    return `${r.label}: ${ties.length} ${ties.length === 1 ? "tie" : "ties"}${best ? `, strongest with ${best.label} (${formatWeight(w(r.id, best.id))} ${weightName})` : ""}`;
  })();

  const onKey = (e: KeyboardEvent<SVGGElement>, id: number) => {
    if ((e.key === "Enter" || e.key === " ") && onSelect) {
      e.preventDefault();
      onSelect(id);
    }
  };
  const lit = (i: number) => hover !== null && (hover.row === i || hover.col === i);

  return (
    <div ref={ref} className="w-full">
      <p className="min-h-[1.25rem] text-sm text-muted" aria-live="polite">
        {status}
      </p>
      <ScrollRegion label={ariaLabel} className="mt-1">
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} role="group" aria-label={ariaLabel} fontSize={12} style={{ display: "block", maxWidth: "none" }}>
          <defs>
            <linearGradient id="adj-matrix-ramp" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor={rampColor(0)} />
              <stop offset="1" stopColor={rampColor(1)} />
            </linearGradient>
          </defs>
          <rect x={LEFT} y={TOP} width={gridW} height={gridW} fill={C.empty} stroke={C.ruleStrong} />

          {/* cells */}
          {nodes.map((r, i) =>
            nodes.map((c, j) => {
              if (i === j) return <rect key={`${i}-${j}`} x={LEFT + j * cell} y={TOP + i * cell} width={cell} height={cell} fill={C.grid} />;
              const v = w(r.id, c.id);
              if (!(v > 0) || v < minWeight) return null;
              const t = shade(v, max);
              const faded = r.dimmed || c.dimmed;
              return (
                <g key={`${i}-${j}`} data-weight={v} opacity={faded ? 0.15 : 1} onMouseEnter={() => setHover({ row: i, col: j })} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(r.id)} style={{ cursor: onSelect ? "pointer" : "default" }}>
                  <rect x={LEFT + j * cell + 1} y={TOP + i * cell + 1} width={cell - 2} height={cell - 2} fill={rampColor(t)} />
                  {showValues && cell >= 24 && (
                    <text x={LEFT + j * cell + cell / 2} y={TOP + i * cell + cell / 2 + 4} textAnchor="middle" fontSize={11} fill={t > 0.55 ? "#fff" : C.ink} aria-hidden="true">
                      {formatWeight(v)}
                    </text>
                  )}
                </g>
              );
            }),
          )}

          {/* group blocks along the diagonal */}
          {blocks &&
            groupRuns(nodes).map(([a, b]) => (
              <rect key={`blk-${a}`} x={LEFT + a * cell} y={TOP + a * cell} width={(b - a) * cell} height={(b - a) * cell} fill="none" stroke={nodes[a].color} strokeWidth={2} pointerEvents="none" />
            ))}

          {/* hover cross-hair */}
          {hover && (
            <>
              <rect x={LEFT} y={TOP + hover.row * cell} width={gridW} height={cell} fill="none" stroke={C.ink} strokeWidth={1} pointerEvents="none" />
              {hover.col !== null && <rect x={LEFT + hover.col * cell} y={TOP} width={cell} height={gridW} fill="none" stroke={C.ink} strokeWidth={1} pointerEvents="none" />}
            </>
          )}

          {/* highlighted (ego) and selected rows */}
          {nodes.map((d, i) =>
            d.id === highlightId || d.id === selectedId ? (
              <g key={`hl-${d.id}`} pointerEvents="none">
                <rect x={LEFT} y={TOP + i * cell} width={gridW} height={cell} fill="none" stroke={C.accent} strokeWidth={2} />
                <rect x={LEFT + i * cell} y={TOP} width={cell} height={gridW} fill="none" stroke={C.accent} strokeWidth={2} />
              </g>
            ) : null,
          )}

          {/* row labels: the keyboard stops */}
          {nodes.map((d, i) => {
            const y = TOP + i * cell + cell / 2;
            const strong = lit(i) || d.id === highlightId || d.id === selectedId;
            return (
              <g
                key={`row-${d.id}`}
                tabIndex={onSelect ? 0 : undefined}
                role={onSelect ? "button" : undefined}
                aria-label={`${d.label}${markerName && d.marker != null ? `, ${markerName} ${d.marker.toFixed(2)}` : ""}`}
                onKeyDown={(e) => onKey(e, d.id)}
                onFocus={() => setHover({ row: i, col: null })}
                onBlur={() => setHover(null)}
                onMouseEnter={() => setHover({ row: i, col: null })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelect?.(d.id)}
                opacity={d.dimmed ? 0.35 : 1}
                style={{ cursor: onSelect ? "pointer" : "default" }}
              >
                <rect x={0} y={TOP + i * cell} width={LEFT - 2} height={cell} fill="transparent" />
                <text x={LEFT - MARK - 16} y={y + 4} textAnchor="end" fill={strong ? C.ink : C.muted} fontWeight={strong ? 600 : 400} fontSize={cell < 16 ? 11 : 12}>
                  {clip(d.label)}
                </text>
                <rect x={LEFT - MARK - 11} y={y - 4} width={8} height={8} fill={d.color} />
                {hasMarker && d.marker != null && (
                  <>
                    <rect x={LEFT - MARK} y={y - 2} width={MARK - 6} height={4} fill={C.grid} />
                    <rect x={LEFT - MARK} y={y - 2} width={Math.max(1, (MARK - 6) * d.marker)} height={4} fill={C.accent} />
                  </>
                )}
              </g>
            );
          })}

          {/* column labels */}
          {nodes.map((d, j) => (
            <g key={`col-${d.id}`} opacity={d.dimmed ? 0.35 : 1} aria-hidden="true">
              <rect x={LEFT + j * cell + cell / 2 - 4} y={TOP - 12} width={8} height={8} fill={d.color} />
              <text transform={`translate(${LEFT + j * cell + cell / 2 + 4}, ${TOP - 18}) rotate(-60)`} fill={lit(j) || d.id === highlightId ? C.ink : C.muted} fontWeight={lit(j) || d.id === highlightId ? 600 : 400} fontSize={cell < 16 ? 11 : 12}>
                {clip(d.label)}
              </text>
            </g>
          ))}

          {/* ramp legend */}
          <text x={LEFT} y={TOP + gridW + 18} fill={C.muted}>
            {weightName.charAt(0).toUpperCase() + weightName.slice(1)}
          </text>
          <rect x={LEFT} y={TOP + gridW + 24} width={120} height={10} fill="url(#adj-matrix-ramp)" stroke={C.ruleStrong} />
          <text x={LEFT} y={TOP + gridW + 48} fill={C.muted}>
            weaker
          </text>
          <text x={LEFT + 120} y={TOP + gridW + 48} textAnchor="end" fill={C.muted}>
            {max > 0 ? formatWeight(max) : "stronger"}
          </text>
        </svg>
      </ScrollRegion>
    </div>
  );
}
