import { useState } from "react";
import { TREND_COLOR_VAR, TREND_GLYPH } from "../components/TrendBadge";
import { useContainerWidth } from "../lib/useContainerWidth";
import {
  asTrendLabel,
  describeSlot,
  formatAxisPercent,
  growthAxisMax,
  growthMark,
  niceScale,
  tickYears,
  type TrendRule,
  type YearSlot,
} from "../lib/trend";

// Literal fallbacks keep an exported .svg readable outside the app, where the
// custom properties do not exist.
const C = {
  accent: "var(--color-accent, #1d4f91)",
  bar: "var(--color-bar, #b9c1cf)",
  ink: "var(--color-ink, #18232f)",
  muted: "var(--color-muted, #55626f)",
  faint: "var(--color-faint, #8592a0)",
  ruleStrong: "var(--color-rule-strong, #b5bdc7)",
  sheet: "var(--color-sheet, #ffffff)",
  grid: "#e7eaee",
};

const M = { left: 48, right: 12 };
const CAPTION_1_Y = 12;
const BARS_TOP = 22;
const BARS_H = 140;
const BARS_BOTTOM = BARS_TOP + BARS_H;
const CAPTION_2_Y = BARS_BOTTOM + 38;
const GROWTH_TOP = CAPTION_2_Y + 8;
const GROWTH_H = 100;
const GROWTH_BOTTOM = GROWTH_TOP + GROWTH_H;
const STRIP_TOP = GROWTH_BOTTOM + 14;
const AXIS_TOP = STRIP_TOP + 16;
const HEIGHT_FULL = AXIS_TOP + 22;
const HEIGHT_BARS_ONLY = BARS_BOTTOM + 28;

interface Props {
  slots: YearSlot[];
  /** Thresholds parsed from the algorithm string; null draws no threshold lines. */
  rule: TrendRule | null;
  /** A year to draw in the accent color (the board's selected year). */
  highlightYear?: number;
}

/** F3 figure: paper-count bars, a growth-rate panel below it (not a dual
 * axis), threshold reference lines read from `rule`, and one trend glyph per
 * year in a strip under the growth panel. Dormant years are gaps with a
 * hollow mark, never zero bars. Every column is keyboard-focusable and the
 * same numbers are in the Figure's table view. design-system.md §5. */
export default function TopicTrendChart({ slots, rule, highlightYear }: Props) {
  const [ref, measured] = useContainerWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const width = Math.max(320, measured);

  const n = slots.length;
  const plotW = width - M.left - M.right;
  const band = plotW / Math.max(n, 1);
  const cx = (i: number) => M.left + band * (i + 0.5);
  const barW = Math.max(2, Math.min(band * 0.7, 48));

  const maxPapers = Math.max(0, ...slots.map((s) => s.point?.paper_count ?? 0));
  const scale = niceScale(maxPapers);
  const yBars = (v: number) => BARS_BOTTOM - (v / scale.max) * BARS_H;

  const gMax = growthAxisMax(rule);
  const yGrowth = (r: number) => GROWTH_TOP + ((gMax - r) / (gMax + 1)) * GROWTH_H;
  const yOffScale = GROWTH_TOP + 5;

  const years = slots.map((s) => s.year);
  const ticks = new Set(tickYears(years, band));
  const activeYear = active ?? highlightYear ?? null;

  // Without growth rates or labels (graph.trends not run) the lower panels
  // would be empty axes, so the figure shrinks to the bars.
  const showGrowth = slots.some((s) => growthMark(s).kind !== "none" || asTrendLabel(s.point?.trend_label) !== null);
  const height = showGrowth ? HEIGHT_FULL : HEIGHT_BARS_ONLY;
  const activeSlot = active === null ? null : (slots.find((s) => s.year === active) ?? null);

  // Continuous runs of measured (not new, not off-scale) growth become line segments.
  const segments: string[] = [];
  let run: string[] = [];
  slots.forEach((s, i) => {
    const g = growthMark(s);
    if (g.kind === "value" && g.rate <= gMax) {
      run.push(`${cx(i)},${yGrowth(g.rate)}`);
    } else {
      if (run.length > 1) segments.push(run.join(" "));
      run = [];
    }
  });
  if (run.length > 1) segments.push(run.join(" "));

  return (
    <div ref={ref} className="w-full">
      <p className="min-h-[1.25rem] text-sm text-muted" aria-hidden="true">
        {activeSlot ? describeSlot(activeSlot) : "Hover or focus a year for its counts."}
      </p>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="Papers per year, growth on the previous year, and trend label, one column per year"
        fontSize={12}
        style={{ display: "block", maxWidth: "none" }}
      >
        {/* Panel 1: papers tagged */}
        <text x={M.left} y={CAPTION_1_Y} fill={C.muted}>
          Papers tagged per year
        </text>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={yBars(t)} y2={yBars(t)} stroke={t === 0 ? C.ruleStrong : C.grid} strokeWidth={1} />
            <text x={M.left - 6} y={yBars(t) + 4} textAnchor="end" fill={C.muted}>
              {t}
            </text>
          </g>
        ))}
        {slots.map((s, i) => {
          if (!s.point) {
            return <circle key={s.year} cx={cx(i)} cy={BARS_BOTTOM - 5} r={2.5} fill="none" stroke={C.faint} strokeWidth={1.25} />;
          }
          const h = Math.max(s.point.paper_count > 0 ? 1 : 0, BARS_BOTTOM - yBars(s.point.paper_count));
          return <rect key={s.year} x={cx(i) - barW / 2} y={BARS_BOTTOM - h} width={barW} height={h} fill={activeYear === s.year ? C.accent : C.bar} />;
        })}
        {slots.map((s, i) =>
          ticks.has(s.year) ? (
            <text key={s.year} x={cx(i)} y={BARS_BOTTOM + 16} textAnchor="middle" fill={C.muted}>
              {s.year}
            </text>
          ) : null,
        )}

        {showGrowth && (
          <g>
        {/* Panel 2: growth on the previous year */}
        <text x={M.left} y={CAPTION_2_Y} fill={C.muted}>
          Growth on the previous year
        </text>
        {[-1, 0, gMax].map((r) => (
          <g key={r}>
            <line x1={M.left} x2={width - M.right} y1={yGrowth(r)} y2={yGrowth(r)} stroke={r === 0 ? C.ruleStrong : C.grid} strokeWidth={1} />
            <text x={M.left - 6} y={yGrowth(r) + 4} textAnchor="end" fill={C.muted}>
              {formatAxisPercent(r)}
            </text>
          </g>
        ))}
        {rule && (
          <g>
            <line x1={M.left} x2={width - M.right} y1={yGrowth(rule.emerging)} y2={yGrowth(rule.emerging)} stroke={TREND_COLOR_VAR.Emerging} strokeWidth={1} strokeDasharray="4 3" />
            <text x={M.left + 4} y={yGrowth(rule.emerging) - 4} fill={TREND_COLOR_VAR.Emerging}>
              Emerging threshold {formatAxisPercent(rule.emerging)}
            </text>
            <line x1={M.left} x2={width - M.right} y1={yGrowth(rule.declining)} y2={yGrowth(rule.declining)} stroke={TREND_COLOR_VAR.Declining} strokeWidth={1} strokeDasharray="4 3" />
            <text x={M.left + 4} y={yGrowth(rule.declining) + 14} fill={TREND_COLOR_VAR.Declining}>
              Declining threshold {formatAxisPercent(rule.declining)}
            </text>
          </g>
        )}
        {segments.map((pts) => (
          <polyline key={pts} points={pts} fill="none" stroke={C.accent} strokeWidth={1.5} />
        ))}
        {slots.map((s, i) => {
          const g = growthMark(s);
          if (g.kind === "none") return null;
          if (g.kind === "new") {
            return <circle key={s.year} cx={cx(i)} cy={yOffScale} r={3.5} fill={C.sheet} stroke={C.accent} strokeWidth={1.5} />;
          }
          if (g.rate > gMax) {
            const x = cx(i);
            return <path key={s.year} d={`M${x},${GROWTH_TOP} L${x + 4.5},${GROWTH_TOP + 9} L${x - 4.5},${GROWTH_TOP + 9} Z`} fill={C.accent} />;
          }
          return <circle key={s.year} cx={cx(i)} cy={yGrowth(g.rate)} r={3} fill={C.accent} />;
        })}

        {/* Label strip: one glyph per classified year, color plus shape */}
        <text x={M.left - 6} y={STRIP_TOP + 12} textAnchor="end" fill={C.muted}>
          Label
        </text>
        {slots.map((s, i) => {
          const label = asTrendLabel(s.point?.trend_label);
          if (!label) return null;
          return (
            <text key={s.year} x={cx(i)} y={STRIP_TOP + 12} textAnchor="middle" fontSize={13} fill={TREND_COLOR_VAR[label]}>
              {TREND_GLYPH[label]}
            </text>
          );
        })}
        {slots.map((s, i) =>
          ticks.has(s.year) ? (
            <text key={s.year} x={cx(i)} y={AXIS_TOP + 14} textAnchor="middle" fill={C.muted}>
              {s.year}
            </text>
          ) : null,
        )}
          </g>
        )}

        {/* One focusable, labelled column per year; the readout above the figure follows it. */}
        {slots.map((s, i) => (
          <rect
            key={s.year}
            x={M.left + band * i}
            y={BARS_TOP}
            width={band}
            height={(showGrowth ? AXIS_TOP : BARS_BOTTOM + 20) - BARS_TOP}
            fill="transparent"
            tabIndex={0}
            role="img"
            aria-label={describeSlot(s)}
            onMouseEnter={() => setActive(s.year)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(s.year)}
            onBlur={() => setActive(null)}
          />
        ))}
      </svg>
    </div>
  );
}
