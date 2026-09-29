interface YearCount {
  year: number;
  paper_count: number;
}

/** Every year from the first to the last, with 0 for years the API omits,
 * so a quiet year shows as a gap instead of silently vanishing. */
export function fillYears(data: YearCount[]): YearCount[] {
  if (data.length === 0) return [];
  const byYear = new Map(data.map((d) => [d.year, d.paper_count]));
  const years = data.map((d) => d.year);
  const out: YearCount[] = [];
  for (let y = Math.min(...years); y <= Math.max(...years); y++) out.push({ year: y, paper_count: byYear.get(y) ?? 0 });
  return out;
}

/** "Papers by year" on the author, institution and venue pages: one bar per
 * year with its count above it. Each bar sits in a fixed-height track so its
 * percentage height has something definite to resolve against (without the
 * track every bar collapsed to 0 px). */
export default function PapersByYear({ data }: { data: YearCount[] }) {
  const series = fillYears(data);
  if (series.length === 0) return null;
  const max = Math.max(1, ...series.map((d) => d.paper_count));

  return (
    <section className="mt-6">
      <h2 className="font-serif text-lg font-semibold">Papers by year</h2>
      <ol className="mt-2 flex items-end gap-1" aria-label="Papers by year">
        {series.map((d) => (
          <li key={d.year} className="flex min-w-0 flex-1 flex-col items-center" title={`${d.year}: ${d.paper_count}`}>
            <span aria-hidden="true" className="text-[11px] tabular-nums text-muted">
              {d.paper_count > 0 ? d.paper_count : ""}
            </span>
            <div aria-hidden="true" className="flex h-20 w-full items-end">
              {d.paper_count > 0 && <div className="w-full bg-accent" style={{ height: `${Math.max(4, (d.paper_count / max) * 100)}%` }} />}
            </div>
            <span aria-hidden="true" className="mt-1 text-[10px] text-muted">
              {String(d.year).slice(2)}
            </span>
            <span className="sr-only">
              {d.year}: {d.paper_count} {d.paper_count === 1 ? "paper" : "papers"}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
