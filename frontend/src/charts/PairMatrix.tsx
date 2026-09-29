import { useState, type KeyboardEvent } from "react";
import type { ConvergingTopicPair } from "../api/topics";
import { describePairCell, rampColor, scoreShade, type PairMatrix as PairMatrixData } from "../lib/convergence";

// Literal fallbacks keep an exported .svg readable outside the app.
const C = {
  ink: "var(--color-ink, #18232f)",
  muted: "var(--color-muted, #55626f)",
  faint: "var(--color-faint, #8592a0)",
  rule: "var(--color-rule, #d8dde3)",
  ruleStrong: "var(--color-rule-strong, #b5bdc7)",
  grid: "#e7eaee",
  empty: "var(--color-paper, #f6f7f9)",
};
const RAMP_LOW = "#e3ecf7";
const RAMP_HIGH = "#1d4f91";

const CELL = 20;
const LEFT = 176;
const TOP = 156;
const RIGHT = 12;
const LEGEND_H = 56;
const LABEL_CHARS = 24;

function clip(name: string): string {
  return name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}\u2026` : name;
}

interface Props {
  matrix: PairMatrixData;
  /** The score that maps to the darkest cell: the board passes the page's
   * highest score (unfiltered) so cell shading matches the score bars in the
   * ranked table beside it. Shading is on a log scale (lib/convergence.ts#scoreShade). */
  maxScore: number;
  onSelectPair?: (pair: ConvergingTopicPair) => void;
}

/** Phase 6c's overview figure (design-system.md §5, Convergence): topics x
 * topics, cell = convergence score on the sequential ramp. Mirrored across
 * the diagonal so a pair reads from either topic; the diagonal is blank (a
 * topic is not paired with itself). Only one cell per pair is focusable, so
 * keyboard users get the same number of stops as the ranked table has rows;
 * Enter or Space opens the pair drawer, like a table row. Everything drawn
 * here is also in the figure's table view. */
export default function PairMatrix({ matrix, maxScore, onSelectPair }: Props) {
  const [active, setActive] = useState<ConvergingTopicPair | null>(null);
  const n = matrix.topics.length;
  const width = LEFT + n * CELL + RIGHT;
  const height = TOP + n * CELL + LEGEND_H;
  const gridBottom = TOP + n * CELL;

  const isActiveTopic = (id: number) => active !== null && (active.topic_a_id === id || active.topic_b_id === id);
  const activate = (pair: ConvergingTopicPair) => onSelectPair?.(pair);
  const onKey = (e: KeyboardEvent<SVGRectElement>, pair: ConvergingTopicPair) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(pair);
    }
  };

  return (
    <div className="w-full">
      <p className="min-h-[1.25rem] text-sm text-muted" aria-hidden="true">
        {active ? describePairCell(active) : "Hover or focus a cell for the pair's score and shared papers. Press Enter to open it."}
      </p>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="Matrix of converging topic pairs, shaded by convergence score. The table view lists the same pairs."
        fontSize={12}
        style={{ display: "block", maxWidth: "none" }}
      >
        <defs>
          <linearGradient id="pair-matrix-ramp" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={RAMP_LOW} />
            <stop offset="1" stopColor={RAMP_HIGH} />
          </linearGradient>
        </defs>

        <rect x={LEFT} y={TOP} width={n * CELL} height={n * CELL} fill={C.empty} stroke={C.ruleStrong} strokeWidth={1} />
        {matrix.topics.map((t, i) => (
          <g key={t.id}>
            {i > 0 && <line x1={LEFT} x2={LEFT + n * CELL} y1={TOP + i * CELL} y2={TOP + i * CELL} stroke={C.grid} strokeWidth={1} />}
            {/* Blank diagonal: a topic is never paired with itself. */}
            <rect x={LEFT + i * CELL + 1} y={TOP + i * CELL + 1} width={CELL - 2} height={CELL - 2} fill={C.grid} />
            <text x={LEFT - 6} y={TOP + i * CELL + CELL / 2 + 4} textAnchor="end" fill={isActiveTopic(t.id) ? C.ink : C.muted} fontWeight={isActiveTopic(t.id) ? 600 : 400}>
              {clip(t.name)}
            </text>
            <text
              transform={`translate(${LEFT + i * CELL + CELL / 2 + 4}, ${TOP - 8}) rotate(-90)`}
              textAnchor="start"
              fill={isActiveTopic(t.id) ? C.ink : C.muted}
              fontWeight={isActiveTopic(t.id) ? 600 : 400}
            >
              {clip(t.name)}
            </text>
          </g>
        ))}

        {matrix.cells.map((c) => {
          const fill = rampColor(scoreShade(c.pair.convergence_score, maxScore));
          const common = {
            x: LEFT + c.col * CELL + 1,
            y: TOP + c.row * CELL + 1,
            width: CELL - 2,
            height: CELL - 2,
            fill,
            onMouseEnter: () => setActive(c.pair),
            onMouseLeave: () => setActive(null),
            onClick: () => activate(c.pair),
            style: { cursor: onSelectPair ? "pointer" : "default" },
          };
          return c.primary ? (
            <rect
              key={`${c.row}-${c.col}`}
              {...common}
              tabIndex={0}
              role="button"
              aria-label={describePairCell(c.pair)}
              onFocus={() => setActive(c.pair)}
              onBlur={() => setActive(null)}
              onKeyDown={(e) => onKey(e, c.pair)}
            />
          ) : (
            <rect key={`${c.row}-${c.col}`} {...common} aria-hidden="true" />
          );
        })}

        {/* Ramp legend, in the left gutter so a small matrix never clips it:
            lightest = lowest, darkest = the page's highest score. */}
        <text x={12} y={gridBottom + 16} fill={C.muted}>
          Convergence score
        </text>
        <rect x={12} y={gridBottom + 22} width={96} height={10} fill="url(#pair-matrix-ramp)" stroke={C.ruleStrong} strokeWidth={1} />
        <text x={12} y={gridBottom + 46} fill={C.muted}>
          lower
        </text>
        <text x={108} y={gridBottom + 46} textAnchor="end" fill={C.muted}>
          {maxScore > 0 ? maxScore.toFixed(2) : "higher"}
        </text>
      </svg>
    </div>
  );
}
