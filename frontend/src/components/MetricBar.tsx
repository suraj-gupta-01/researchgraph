interface Props {
  label: string;
  value: number;
  max: number;
  explanation?: string;
  rank?: string; // e.g. "3rd of 48"
  formatValue?: (v: number) => string;
}

/** "betweenness 0.041, 3rd of 48" — a number plus a bar against the
 * corpus range, with a one-sentence plain-language explanation
 * (design-system.md §4, §7). */
export default function MetricBar({ label, value, max, explanation, rank, formatValue }: Props) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const shown = formatValue ? formatValue(value) : value.toFixed(3);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">
          {shown}
          {rank ? `, ${rank}` : ""}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full bg-rule">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      {explanation && <p className="mt-1 text-xs leading-relaxed text-muted">{explanation}</p>}
    </div>
  );
}
