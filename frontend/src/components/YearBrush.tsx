import type { Schemas } from "../api/client";

type YearCount = Schemas["YearCount"];

interface Props {
  histogram: YearCount[];
  from?: number;
  to?: number;
  onChange: (from?: number, to?: number) => void;
}

/** Publication volume by year. Doubles as the year filter: click a bar for
 * one year, click a second bar to span the years between. Reads
 * `year_histogram`, which the backend deliberately computes ignoring the
 * year filter, so it keeps working as a selector (api-coverage.md §3). */
export default function YearBrush({ histogram, from, to, onChange }: Props) {
  if (histogram.length === 0) return null;
  const first = histogram[0].year;
  const last = histogram[histogram.length - 1].year;
  const counts = new Map(histogram.map((h) => [h.year, h.paper_count]));
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const max = Math.max(...histogram.map((h) => h.paper_count));
  const active = (y: number) => (from === undefined && to === undefined) || (y >= (from ?? first) && y <= (to ?? last));
  const single = from !== undefined && from === to;

  const click = (y: number) => {
    if (single && from === y) return onChange(undefined, undefined);
    if (single && from !== undefined) return onChange(Math.min(from, y), Math.max(from, y));
    onChange(y, y);
  };
  const labelEvery = years.length > 14 ? 3 : years.length > 8 ? 2 : 1;

  return (
    <div>
      <div className="flex h-28 items-end gap-1" role="group" aria-label="Papers per year; select a year or a range">
        {years.map((y) => {
          const n = counts.get(y) ?? 0;
          return (
            <button
              key={y}
              type="button"
              onClick={() => click(y)}
              aria-pressed={active(y) && !(from === undefined && to === undefined)}
              aria-label={`${y}: ${n} ${n === 1 ? "paper" : "papers"}`}
              title={`${y}: ${n} ${n === 1 ? "paper" : "papers"}`}
              className="group flex h-full min-w-0 flex-1 flex-col justify-end"
            >
              <span className="mb-0.5 text-center text-[11px] leading-none text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">{n}</span>
              <span
                className={`block w-full ${active(y) ? "bg-accent" : "bg-bar"} group-hover:bg-ink`}
                style={{ height: `${n === 0 ? 2 : Math.max(4, (n / max) * 100)}%`, opacity: n === 0 ? 0.35 : 1 }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1 border-t border-rule pt-1 text-xs text-muted">
        {years.map((y, i) => (
          <span key={y} className="min-w-0 flex-1 text-center">
            {i % labelEvery === 0 || y === last ? y : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
