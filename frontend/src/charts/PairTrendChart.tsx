import { useState } from "react";
import { TREND_COLOR_VAR } from "../components/TrendBadge";
import { describePairSlot, type PairYearSlot } from "../lib/convergence";
import { niceScale, tickYears } from "../lib/trend";
import { useContainerWidth } from "../lib/useContainerWidth";

// Literal fallbacks keep an exported .svg readable outside the app, where
// the custom properties do not exist. Same palette as TopicTrendChart.
const C = {
  accent: "var(--color-accent, #1d4f91)",
  bar: "var(--color-bar, #b9c1cf)",
  muted: "var(--color-muted, #55626f)",
  faint: "var(--color-faint, #8592a0)",
  ruleStrong: "var(--color-rule-strong, #b5bdc7)",
  grid: "#e7eaee",
};

const M = { left: 44, right: 12 };
const BARS_TOP = 22;
const BARS_H = 140;
const BARS_BOTTOM = BARS_TOP + BARS_H;
const AXIS_TOP = BARS_BOTTOM + 16;
const HEIGHT = AXIS_TOP + 22;

interface Props {
  slots: PairYearSlot[];
  /** A year to draw in the accent color when it isn't itself Converging. */
  highlightYear?: number;
}

/** Phase 6b's pair-drawer figure: one bar per year of shared-paper count,
 * years the pair classified as Converging drawn in the trend color, dormant
 * years as gaps -- the single-panel counterpart of TopicTrendChart's bars
 * panel, reusing its scale and tick conventions (lib/trend.ts#niceScale,
 * #tickYears) since a pair's co-occurrence count is the same kind of
 * per-year integer series a topic's paper count is. */
export default function PairTrendChart({ slots, highlightYear }: Props) {
  const [ref, measured] = useContainerWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const width = Math.max(280, measured);

  const n = slots.length;
  const plotW = width - M.left - M.right;
  const band = plotW / Math.max(n, 1);
  const cx = (i: number) => M.left + band * (i + 0.5);
  const barW = Math.max(2, Math.min(band * 0.7, 40));

  const maxCount = Math.max(0, ...slots.map((s) => s.point?.cooccurrence_count ?? 0));
  const scale = niceScale(maxCount);
  const y = (v: number) => BARS_BOTTOM - (v / scale.max) * BARS_H;

  const years = slots.map((s) => s.year);
  const ticks = new Set(tickYears(years, band));
  const activeYear = active ?? highlightYear ?? null;
  const activeSlot = active === null ? null : (slots.find((s) => s.year === active) ?? null);

  return (
    <div ref={ref} className="w-full">
      <p className="min-h-[1.25rem] text-sm text-muted" aria-hidden="true">
        {activeSlot ? describePairSlot(activeSlot) : "Hover or focus a year for its shared-paper count."}
      </p>
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="group"
        aria-label="Shared papers per year, one column per year, converging years highlighted"
        fontSize={12}
        style={{ display: "block", maxWidth: "none" }}
      >
        <text x={M.left} y={12} fill={C.muted}>
          Shared papers per year
        </text>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.ruleStrong : C.grid} strokeWidth={1} />
            <text x={M.left - 6} y={y(t) + 4} textAnchor="end" fill={C.muted}>
              {t}
            </text>
          </g>
        ))}
        {slots.map((s, i) => {
          if (!s.point) {
            return <circle key={s.year} cx={cx(i)} cy={BARS_BOTTOM - 5} r={2.5} fill="none" stroke={C.faint} strokeWidth={1.25} />;
          }
          const h = Math.max(s.point.cooccurrence_count > 0 ? 1 : 0, BARS_BOTTOM - y(s.point.cooccurrence_count));
          const fill = s.point.is_converging ? TREND_COLOR_VAR.Converging : activeYear === s.year ? C.accent : C.bar;
          return <rect key={s.year} x={cx(i) - barW / 2} y={BARS_BOTTOM - h} width={barW} height={h} fill={fill} />;
        })}
        {slots.map((s, i) =>
          ticks.has(s.year) ? (
            <text key={s.year} x={cx(i)} y={AXIS_TOP + 14} textAnchor="middle" fill={C.muted}>
              {s.year}
            </text>
          ) : null,
        )}

        {/* One focusable, labelled column per year; the readout above the figure follows it. */}
        {slots.map((s, i) => (
          <rect
            key={s.year}
            x={M.left + band * i}
            y={BARS_TOP}
            width={band}
            height={AXIS_TOP - BARS_TOP}
            fill="transparent"
            tabIndex={0}
            role="img"
            aria-label={describePairSlot(s)}
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
