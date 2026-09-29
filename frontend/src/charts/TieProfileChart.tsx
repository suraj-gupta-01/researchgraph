import { useState, type KeyboardEvent } from "react";
import type { BridgeAuthor } from "../api/authors";
import { useContainerWidth } from "../lib/useContainerWidth";

export interface CommunityKey {
  id: number;
  label: string;
  color: string;
}

interface Props {
  authors: BridgeAuthor[];
  /** Communities in legend order; segments are stacked in this order on
   * every row, so the same community lines up down the chart. */
  communities: CommunityKey[];
  /** Server rank of the first row (page offset + 1). */
  rankFrom: number;
  onSelect?: (author: BridgeAuthor) => void;
}

const C = {
  ink: "var(--color-ink, #18232f)",
  muted: "var(--color-muted, #55626f)",
  rule: "var(--color-rule, #d8dde3)",
  none: "var(--color-community-none, #9aa5b1)",
};
const ROW = 24;
const BAR = 14;

/** Per community, this author's share of ties, in legend order; ties into
 * communities outside the legend (replaced by a newer run) come last. */
export function orderedSegments(a: Pick<BridgeAuthor, "ties">, order: number[]) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...a.ties].sort((x, y) => (rank.get(x.community_id) ?? 1e9) - (rank.get(y.community_id) ?? 1e9) || x.community_id - y.community_id);
}

/** F4's evidence figure: for each ranked researcher, a 100% bar split by the
 * share of their tie weight going into each detected community. This is the
 * input the bridge score (participation coefficient, 1 - sum of squared
 * shares) is computed from, so it shows *why* a researcher scores as they do
 * and *which* communities they connect. It replaces a bridge-score vs
 * betweenness scatter, which on this corpus squeezed every point into one
 * band: with k communities the score tops out at 1 - 1/k, and most
 * researchers sit just under it. Gridlines at quarters make an even split
 * easy to spot. */
export default function TieProfileChart({ authors, communities, rankFrom, onSelect }: Props) {
  const [ref, width] = useContainerWidth<HTMLDivElement>(800);
  const [active, setActive] = useState<string | null>(null);

  const narrow = width < 600;
  const LEFT = narrow ? 118 : 190;
  const RIGHT = 52;
  const legendCols = narrow ? 1 : 2;
  const legendRows = Math.ceil(communities.length / legendCols);
  const TOP = legendRows * 18 + 32;
  const barW = Math.max(120, width - LEFT - RIGHT);
  const svgW = LEFT + barW + RIGHT;
  const svgH = TOP + authors.length * ROW + 8;
  const colorOf = new Map(communities.map((c) => [c.id, c.color]));
  const order = communities.map((c) => c.id);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const onKey = (e: KeyboardEvent<SVGGElement>, a: BridgeAuthor) => {
    if ((e.key === "Enter" || e.key === " ") && onSelect) {
      e.preventDefault();
      onSelect(a);
    }
  };

  return (
    <div ref={ref} className="w-full">
      <p className="min-h-[1.25rem] text-sm text-muted" aria-live="polite">
        {active ?? "Hover a bar segment for the share of that researcher's ties. Click a researcher for their evidence."}
      </p>
      <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} role="group" aria-label="Share of each researcher's ties going into each community" fontSize={12} style={{ display: "block", maxWidth: "100%" }}>
        {/* legend */}
        {communities.map((c, i) => {
          const col = i % legendCols;
          const row = Math.floor(i / legendCols);
          const x = LEFT + col * (barW / legendCols);
          const y = row * 18 + 10;
          return (
            <g key={`lg-${c.id}`}>
              <rect x={x} y={y - 9} width={10} height={10} fill={c.color} />
              <text x={x + 15} y={y} fill={C.ink}>
                {clip(c.label, narrow ? 30 : 48)}
              </text>
            </g>
          );
        })}

        {/* quarter gridlines + axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={`g-${t}`} aria-hidden="true">
            <line x1={LEFT + t * barW} x2={LEFT + t * barW} y1={TOP - 6} y2={svgH - 6} stroke={C.rule} strokeDasharray={t === 0 || t === 1 ? undefined : "3 3"} />
            {/* On a phone the quarter labels collide; label halves only. */}
            {(!narrow || t === 0 || t === 0.5 || t === 1) && (
              <text x={LEFT + t * barW} y={TOP - 9} textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"} fill={C.muted} fontSize={11}>
                {Math.round(t * 100)}%
              </text>
            )}
          </g>
        ))}
        <text x={LEFT + barW + 8} y={TOP - 9} fill={C.muted} fontSize={11} aria-hidden="true">
          Bridge
        </text>

        {authors.map((a, i) => {
          const y = TOP + i * ROW;
          let x = LEFT;
          const total = a.ties.reduce((s, t) => s + Math.max(0, t.share), 0) || 1;
          return (
            <g
              key={a.author_id}
              tabIndex={onSelect ? 0 : undefined}
              role={onSelect ? "button" : undefined}
              aria-label={`${rankFrom + i}. ${a.full_name}, bridge score ${a.bridge_score.toFixed(2)}: ${orderedSegments(a, order)
                .map((t) => `${Math.round(t.share * 100)}% ${t.label ?? "a replaced community"}`)
                .join(", ")}`}
              onKeyDown={(e) => onKey(e, a)}
              onClick={() => onSelect?.(a)}
              onFocus={() => setActive(`${a.full_name}: bridge score ${a.bridge_score.toFixed(2)}, ties into ${a.communities_touched} communities`)}
              onBlur={() => setActive(null)}
              style={{ cursor: onSelect ? "pointer" : "default" }}
            >
              <rect x={0} y={y} width={svgW} height={ROW} fill="transparent" />
              <text x={LEFT - 8} y={y + ROW / 2 + 4} textAnchor="end" fill={C.ink}>
                <tspan fill={C.muted} fontSize={11}>{`${rankFrom + i}  `}</tspan>
                {clip(a.full_name, narrow ? 13 : 24)}
              </text>
              {orderedSegments(a, order).map((t) => {
                const w = (Math.max(0, t.share) / total) * barW;
                const seg = (
                  <rect
                    key={t.community_id}
                    x={x}
                    y={y + (ROW - BAR) / 2}
                    width={Math.max(0, w - 1)}
                    height={BAR}
                    fill={colorOf.get(t.community_id) ?? C.none}
                    onMouseEnter={() => setActive(`${a.full_name}: ${Math.round(t.share * 100)}% of ties into ${t.label ?? "a replaced community"} (weight ${t.weight.toFixed(1)})`)}
                    onMouseLeave={() => setActive(null)}
                  />
                );
                x += w;
                return seg;
              })}
              <text x={LEFT + barW + 8} y={y + ROW / 2 + 4} fill={C.muted} className="tabular-nums" aria-hidden="true">
                {a.bridge_score.toFixed(2)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
