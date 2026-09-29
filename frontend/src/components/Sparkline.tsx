import { scaleLinear } from "d3-scale";
import { line as d3line, curveMonotoneX } from "d3-shape";

interface Point {
  year: number;
  value: number | null; // null = no data for this year (a gap, never a zero)
}

interface Props {
  points: Point[];
  width?: number;
  height?: number;
}

/** 96x20 inline SVG trend line. A null value is a genuine gap in the
 * series (api-coverage.md §3: "a topic that goes dormant has no snapshot
 * row… draw a gap, never a zero bar") — the line breaks there rather than
 * dropping to the axis. */
export default function Sparkline({ points, width = 96, height = 20 }: Props) {
  if (points.length === 0) return <span className="text-xs text-faint">no data</span>;
  const years = points.map((p) => p.year);
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const x = scaleLinear().domain([Math.min(...years), Math.max(...years)]).range([2, width - 2]);
  const y = scaleLinear()
    .domain([0, Math.max(1, ...values)])
    .range([height - 2, 2]);

  // Split into contiguous non-null runs so gaps render as breaks, not zeros.
  const runs: Point[][] = [];
  let current: Point[] = [];
  for (const p of points) {
    if (p.value === null) {
      if (current.length) runs.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length) runs.push(current);

  const path = d3line<Point>()
    .x((d) => x(d.year))
    .y((d) => y(d.value as number))
    .curve(curveMonotoneX);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Trend sparkline" className="overflow-visible">
      {runs.map((run, i) => (
        <path key={i} d={path(run) ?? undefined} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} />
      ))}
      {points
        .filter((p) => p.value !== null)
        .map((p) => (
          <circle key={p.year} cx={x(p.year)} cy={y(p.value as number)} r={1.25} fill="var(--color-accent)" />
        ))}
    </svg>
  );
}
