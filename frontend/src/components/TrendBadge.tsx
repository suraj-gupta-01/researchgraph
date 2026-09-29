export type TrendLabel = "Emerging" | "Declining" | "Converging" | "Stable";

interface Props {
  label: TrendLabel;
  isNew?: boolean; // the growth_rate === 2.0 "no prior year" constant
}

export const TREND_GLYPH: Record<TrendLabel, string> = {
  Emerging: "\u25B2", // up triangle
  Declining: "\u25BC", // down triangle
  Converging: "\u21C9", // converging arrows (approximated)
  Stable: "\u2013", // dash
};
const COLOR: Record<TrendLabel, string> = {
  Emerging: "text-trend-emerging",
  Declining: "text-trend-declining",
  Converging: "text-trend-converging",
  Stable: "text-trend-stable",
};

/** The same semantics as CSS custom properties with literal fallbacks, for
 * SVG figures: an exported .svg file has no stylesheet, so var() alone would
 * lose the color once the figure leaves the page. */
export const TREND_COLOR_VAR: Record<TrendLabel, string> = {
  Emerging: "var(--color-trend-emerging, #b5490b)",
  Declining: "var(--color-trend-declining, #6c5b9e)",
  Converging: "var(--color-trend-converging, #1f7a66)",
  Stable: "var(--color-trend-stable, #6b7785)",
};

/** Glyph + text + color, never color alone (design-system.md §2, §4). */
export default function TrendBadge({ label, isNew }: Props) {
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${COLOR[label]}`}>
      <span aria-hidden="true">{TREND_GLYPH[label]}</span>
      {isNew ? "New" : label}
    </span>
  );
}
