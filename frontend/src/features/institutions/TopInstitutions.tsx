import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import EntityLink from "../../components/EntityLink";
import Figure from "../../components/Figure";
import { ApiError } from "../../api/client";
import {
  institutionCountries,
  listInstitutions,
  type CountryBreakdown,
  type InstitutionSummary,
} from "../../api/institutions";
import { formatCount } from "../../lib/format";
import { useContainerWidth } from "../../lib/useContainerWidth";

const TOP_N = 25;
const COUNTRIES_SHOWN = 15;

type Rank = "papers" | "authors";
type CountryRow = CountryBreakdown["items"][number];

/** /institutions/top (F6 "top institutions"): the institutions ranked by
 * papers or authors (a server sort of /institutions, never re-sorted
 * here) beside a per-country breakdown (/institutions/countries, counted
 * in SQL). `by` in the URL chooses the ranking. */
export default function TopInstitutions() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const by: Rank = params.get("by") === "authors" ? "authors" : "papers";

  const [top, setTop] = useState<InstitutionSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [countries, setCountries] = useState<CountryBreakdown | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setTop(null);
    listInstitutions(undefined, undefined, by, 0, TOP_N, ctl.signal)
      .then((r) => {
        setTop(r.items);
        setTotal(r.total);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [by]);

  useEffect(() => {
    const ctl = new AbortController();
    institutionCountries(COUNTRIES_SHOWN, ctl.signal)
      .then(setCountries)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, []);

  const columns: Column<InstitutionSummary>[] = [
    { key: "rank", label: "#", align: "right", render: (i) => <span className="text-muted">{top!.indexOf(i) + 1}</span> },
    { key: "name", label: "Institution", render: (i) => <EntityLink kind="institution" id={i.institution_id}>{i.name}</EntityLink> },
    { key: "country", label: "Country", render: (i) => <span className="text-muted">{i.country ?? "—"}</span> },
    { key: "papers", label: "Papers", align: "right", render: (i) => <span className={by === "papers" ? "font-semibold" : ""}>{formatCount(i.paper_count)}</span> },
    { key: "authors", label: "Authors", align: "right", render: (i) => <span className={by === "authors" ? "font-semibold" : ""}>{formatCount(i.author_count)}</span> },
  ];

  const empty = top !== null && total === 0;

  return (
    <div className="pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">Top institutions</h1>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        Where the corpus&rsquo;s papers come from: the most productive institutions, and the same counts per country.{" "}
        <Link to="/institutions/network" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          Who collaborates with whom
        </Link>
      </p>

      {error && <p role="alert" className="mt-5 text-sm text-warn">Could not load institutions ({error.message}).</p>}
      {empty && (
        <p className="mt-5 max-w-xl text-sm text-muted">
          No institutions are loaded yet. Run <code className="font-mono text-[13px]">python -m ingestion.seed_dev</code> (synthetic) or <code className="font-mono text-[13px]">python -m ingestion.run_ingestion</code> (real data).
        </p>
      )}

      {!empty && (
        <div className="mt-6 grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section aria-labelledby="top-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="top-heading" className="font-serif text-lg font-semibold">
                Top {TOP_N} of {formatCount(total)}
              </h2>
              <div role="radiogroup" aria-label="Rank by" className="flex text-sm">
                {(["papers", "authors"] as Rank[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={by === r}
                    onClick={() => setParams(r === "papers" ? {} : { by: r }, { replace: true })}
                    className={`border border-rule-strong px-3 py-1 first:rounded-l-sm last:rounded-r-sm ${by === r ? "bg-accent text-white" : "bg-sheet hover:bg-accent-soft"}`}
                  >
                    By {r}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3">
              {top === null ? (
                <p className="text-sm text-muted">Loading&hellip;</p>
              ) : (
                <DataTable columns={columns} rows={top} rowKey={(i) => i.institution_id} caption={`Top institutions by ${by}`} onRowActivate={(i) => navigate(`/institutions/${i.institution_id}`)} />
              )}
            </div>
            <p className="mt-2 text-sm">
              <Link to={`/institutions?sort=${by}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                All institutions
              </Link>
            </p>
          </section>

          <section aria-labelledby="country-heading">
            <h2 id="country-heading" className="sr-only">By country</h2>
            {countries === null ? <p className="text-sm text-muted">Loading&hellip;</p> : <CountryFigure data={countries} />}
          </section>
        </div>
      )}
    </div>
  );
}

function CountryFigure({ data }: { data: CountryBreakdown }) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>(420);
  const rows = data.items;
  const labelOf = (r: CountryRow) => r.country ?? "Unknown country";
  const max = Math.max(1, ...rows.map((r) => r.paper_count));
  const ROW = 22;
  const LABEL_W = Math.min(150, Math.max(90, width * 0.32));
  const VALUE_W = 44;
  const barW = Math.max(40, width - LABEL_W - VALUE_W - 8);
  const height = rows.length * ROW + 4;

  const table = (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Institutions, papers and authors per country</caption>
      <thead>
        <tr>
          <th scope="col" className="border-b border-rule px-2 py-1 text-left">Country</th>
          <th scope="col" className="border-b border-rule px-2 py-1 text-right">Institutions</th>
          <th scope="col" className="border-b border-rule px-2 py-1 text-right">Papers</th>
          <th scope="col" className="border-b border-rule px-2 py-1 text-right">Authors</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={labelOf(r)} className="border-b border-rule last:border-b-0">
            <td className="px-2 py-1">
              {r.country ? (
                <Link to={`/institutions?country=${encodeURIComponent(r.country)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                  {r.country}
                </Link>
              ) : (
                <span className="italic text-muted">Unknown country</span>
              )}
            </td>
            <td className="px-2 py-1 text-right tabular-nums">{formatCount(r.institution_count)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{formatCount(r.paper_count)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{formatCount(r.author_count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const svg = (
    <div ref={wrapRef}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Papers per country, ${rows.map((r) => `${labelOf(r)} ${r.paper_count}`).join(", ")}`}>
        {rows.map((r, i) => {
          const y = i * ROW + 2;
          const w = (r.paper_count / max) * barW;
          return (
            <g key={labelOf(r)}>
              <text x={LABEL_W - 8} y={y + ROW / 2} dominantBaseline="middle" textAnchor="end" fontSize={12} fill={r.country ? "var(--color-ink, #18232f)" : "var(--color-muted, #55626f)"} fontStyle={r.country ? undefined : "italic"}>
                {labelOf(r).length > 22 ? `${labelOf(r).slice(0, 21)}…` : labelOf(r)}
              </text>
              <rect x={LABEL_W} y={y + 4} width={Math.max(1, w)} height={ROW - 8} fill={i === 0 ? "var(--color-accent, #1d4f91)" : "var(--color-bar, #b9c1cf)"} />
              <text x={LABEL_W + w + 6} y={y + ROW / 2} dominantBaseline="middle" fontSize={12} fill="var(--color-muted, #55626f)" style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatCount(r.paper_count)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );

  return (
    <Figure
      title="Papers by country"
      subtitle={`Top ${rows.length} countries by papers`}
      caption={`${formatCount(data.total_papers)} papers with an institution attribution, from ${formatCount(data.total_institutions)} institutions. A paper with authors in two countries counts for both, so the bars can sum to more.`}
      svg={svg}
      tableView={table}
      csv={{
        filename: "papers-by-country.csv",
        headers: ["country", "institutions", "papers", "authors"],
        rows: rows.map((r) => [r.country ?? "", r.institution_count, r.paper_count, r.author_count]),
      }}
      method={{
        algorithm: null,
        algorithmNote: "SQL aggregate, no analysis job",
        linkToMethods: false, // a plain count, no analysis run to point at
        explanation: "Distinct papers and authors per country, counted in PostgreSQL over the paper-institution view. An author's institution is matched to a paper by publication year.",
      }}
    />
  );
}
