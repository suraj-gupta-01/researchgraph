import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import NoticeBar from "../../components/NoticeBar";
import { ApiError } from "../../api/client";
import { metaRuns, type AnalysisRun, type MetaRuns, type ProvenanceCheck } from "../../api/meta";
import { formatCount, formatDate } from "../../lib/format";
import ScrollRegion from "../../components/ScrollRegion";

interface MethodText {
  title: string;
  command: string;
  after?: string;
  /** Where the analysis's results are shown. */
  surface?: { to: string; label: string };
  body: ReactNode;
}

/** Plain-language methods, one per analysis, in pipeline order. The
 * numbers here are the backend's documented constants
 * (graph/build_graph.py, graph/community_core.py, graph/trend_core.py,
 * graph/convergence_core.py, graph/influence_core.py); the run cards
 * beside them show what the last run actually used. */
const METHODS: Record<string, MethodText> = {
  graph: {
    title: "Collaboration graph",
    command: "python -m graph.build_graph",
    body: (
      <>
        <p>
          Authors are linked when there is evidence they work in the same area. Four signals add weight to a pair: each co-authored paper adds 3, each citation from one author&rsquo;s paper to the other&rsquo;s adds 1, each shared institutional collaboration adds 0.75, and each shared topic adds 0.5.
        </p>
        <p>
          A topic tagged on more than 40% of all papers is left out of the shared-topic signal, because it says nothing about which sub-community an author belongs to. Topic tags count only at relevance 0.3 or higher.
        </p>
      </>
    ),
  },
  communities: {
    title: "Research communities",
    command: "python -m graph.communities",
    after: "topic extraction",
    surface: { to: "/communities", label: "Communities" },
    body: (
      <>
        <p>
          Louvain modularity maximisation partitions the collaboration graph. A fixed random seed makes the result reproducible, and communities below the minimum size are discarded, leaving their authors unassigned.
        </p>
        <p>
          <strong className="font-semibold">Membership score</strong> is the share of an author&rsquo;s tie weight that stays inside their community: 1.0 means every tie is to a community-mate. <strong className="font-semibold">Labels</strong> come from the community&rsquo;s most distinctive topics, each scored by its share of the community&rsquo;s papers times ln(1 / its share of all papers).
        </p>
        <p>Community IDs are new on every run, so do not keep links to a community across runs.</p>
      </>
    ),
  },
  trends: {
    title: "Emerging and declining topics",
    command: "python -m graph.trends",
    after: "topic extraction",
    surface: { to: "/trends", label: "Trends" },
    body: (
      <>
        <p>
          Each topic&rsquo;s yearly paper count is compared with the year before. Growth is (this year &minus; last year) / last year. A year needs at least 3 papers to be labeled at all. <strong className="font-semibold">Emerging</strong> means growth of at least +30%, <strong className="font-semibold">Declining</strong> means &minus;30% or worse, and anything else is Stable.
        </p>
        <p>
          A topic with no papers the year before is shown as &ldquo;new&rdquo; rather than a percentage. Rates are capped at &ge; 999%. A year in which a topic has no papers has no row and is drawn as a gap, not a zero.
        </p>
      </>
    ),
  },
  convergence: {
    title: "Interdisciplinary connections",
    command: "python -m graph.convergence",
    after: "graph.trends",
    surface: { to: "/connections", label: "Interdisciplinary connections" },
    body: (
      <>
        <p>
          For each pair of topics, the papers tagged with both are counted per year. A pair is <strong className="font-semibold">Converging</strong> in a year when it co-occurs on at least 3 papers and that count grew by at least +30%, the same bar as an emerging topic. The convergence score is that growth rate.
        </p>
        <p>
          Topics in a top converging pair are relabeled Converging for that year, replacing Stable. Rerunning graph.trends clears those labels until convergence runs again. A known limit: a dominant topic can &ldquo;converge&rdquo; with its own sub-topics, which is not a meeting of separate fields.
        </p>
      </>
    ),
  },
  influence: {
    title: "Researcher influence and bridges",
    command: "python -m graph.influence",
    after: "graph.communities",
    surface: { to: "/bridges", label: "Bridge researchers" },
    body: (
      <>
        <p>
          Computed on the same collaboration graph the communities come from. <strong className="font-semibold">Degree</strong> is the share of other authors someone has a tie with. <strong className="font-semibold">Betweenness</strong> is how often they sit on the shortest path between two others. Tie strength is converted to distance (1 / weight) first, so strong ties count as short paths. <strong className="font-semibold">PageRank</strong> uses the tie weights directly.
        </p>
        <p>
          <strong className="font-semibold">Bridge score</strong> is the participation coefficient, 1 &minus; &Sigma;(share of tie weight into each community)&sup2;. It is 0 when all of an author&rsquo;s ties go to one community and rises as they spread evenly across several. A score of 0 with no communities touched means no ties into any community, not low influence.
        </p>
      </>
    ),
  },
  provenance: {
    title: "Data provenance",
    command: "python -m ingestion.validate_provenance",
    body: (
      <>
        <p>
          Papers come from OpenAlex and Semantic Scholar through per-source adapters. Records are merged on DOI first, then ORCID for authors, then each source&rsquo;s own ID, with fuzzy title and name matching as a last resort. Low-confidence matches go to a review queue instead of being merged.
        </p>
        <p>
          Every paper keeps one provenance row per source. When sources disagree, the reconciled citation count prefers Semantic Scholar and falls back to OpenAlex. The validation checks below re-verify these rules against the database after every load.
        </p>
      </>
    ),
  },
};

const STATUS_TEXT: Record<string, { label: string; tone: string; note?: string }> = {
  ok: { label: "Up to date", tone: "text-ink" },
  not_run: { label: "Not run yet", tone: "text-muted" },
  postgres_only: { label: "Summary missing", tone: "text-warn", note: "The results exist, but the run summary in MongoDB is missing, so parameters and counts are unavailable. The algorithm and date come from the result rows." },
  mismatch: { label: "Summary from another run", tone: "text-warn", note: "The stored run summary belongs to a different run than the results shown across the app. The algorithm and date here are the ones on the results; rerun the job to refresh the summary." },
};

const CHECK_TONE: Record<string, string> = {
  pass: "text-ink",
  warn: "text-warn",
  fail: "text-warn font-semibold",
  skipped: "text-muted italic",
};

/** /methods (Phase 8, G4): how every analysis works and when it last ran.
 * Each run card reads /meta/runs; a run whose summary is missing or from a
 * different run says so rather than showing parameters that may not
 * describe the data on screen. `skipped` provenance checks are counted
 * apart from passes, never folded into them. */
export default function MethodsPage() {
  const [data, setData] = useState<MetaRuns | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    metaRuns(ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, []);

  return (
    <div className="max-w-4xl pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">Methods &amp; runs</h1>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        How each analysis is computed, and the parameters and date of its last run. Run them in this order, since each needs the one before: topic extraction, then communities, then influence; trends, then convergence.
      </p>

      {error && <p role="alert" className="mt-5 text-sm text-warn">Could not load run information ({error.message}).</p>}
      {data?.mongo === "unavailable" && (
        <div className="mt-5">
          <NoticeBar kind="degraded">MongoDB is unavailable, so run summaries and provenance checks cannot be read. Algorithms and dates below come from the result tables where they exist.</NoticeBar>
        </div>
      )}

      <nav aria-label="Analyses" className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {Object.entries(METHODS).map(([key, m]) => (
          <a key={key} href={`#${key}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
            {m.title}
          </a>
        ))}
      </nav>

      <div className="mt-6 space-y-8">
        {Object.entries(METHODS).map(([key, m]) => (
          <section key={key} id={key} aria-labelledby={`${key}-h`} className="scroll-mt-20 border-t border-rule pt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={`${key}-h`} className="font-serif text-xl font-semibold">{m.title}</h2>
              {m.surface && (
                <Link to={m.surface.to} className="text-sm text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                  {m.surface.label}
                </Link>
              )}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="space-y-2 text-[15px] leading-relaxed">{m.body}</div>
              <RunCard run={data?.runs.find((r) => r.analysis === key) ?? null} loading={!data && !error} method={m} />
            </div>
            {key === "provenance" && data && <ProvenanceTable checks={data.provenance_checks} />}
          </section>
        ))}
      </div>
    </div>
  );
}

function RunCard({ run, loading, method }: { run: AnalysisRun | null; loading: boolean; method: MethodText }) {
  if (loading) return <div className="border border-rule-strong bg-sheet p-4 text-sm text-muted">Loading run&hellip;</div>;
  const status = STATUS_TEXT[run?.status ?? "not_run"] ?? { label: run?.status ?? "Unknown", tone: "text-muted" };
  const counts = Object.entries(run?.counts ?? {}).filter(([k]) => k !== "ok");
  const params = Object.entries(run?.params ?? {});
  return (
    <aside className="self-start border border-rule-strong bg-sheet p-4 text-sm" aria-label={`${method.title}: last run`}>
      <p className={`font-semibold ${status.tone}`}>{status.label}</p>
      {!run || run.status === "not_run" ? (
        <p className="mt-2 text-muted">
          {method.after ? <>After {method.after}, run </> : <>Run </>}
          <code className="font-mono text-[13px]">{method.command}</code>.
        </p>
      ) : (
        <dl className="mt-2 space-y-1">
          {run.algorithm && (
            <div>
              <dt className="inline text-muted">Algorithm: </dt>
              <dd className="inline break-all font-mono text-[13px]">{run.algorithm}</dd>
            </div>
          )}
          {run.detected_at && (
            <div>
              <dt className="inline text-muted">Last run: </dt>
              <dd className="inline">{formatDate(run.detected_at)}</dd>
            </div>
          )}
          {params.length > 0 && (
            <div>
              <dt className="inline text-muted">Parameters: </dt>
              <dd className="inline font-mono text-[13px]">{params.map(([k, v]) => `${k}=${String(v)}`).join(", ")}</dd>
            </div>
          )}
          {run.postgres_rows !== null && run.postgres_rows !== undefined && (
            <div>
              <dt className="inline text-muted">Result rows: </dt>
              <dd className="inline tabular-nums">{formatCount(run.postgres_rows)}</dd>
            </div>
          )}
          {counts.length > 0 && (
            <div className="pt-1">
              <dt className="text-muted">Counts</dt>
              <dd>
                <ul className="mt-0.5 space-y-0.5">
                  {counts.map(([k, v]) => (
                    <li key={k} className="flex justify-between gap-3">
                      <span>{humanize(k)}</span>
                      <span className="tabular-nums">{typeof v === "number" ? formatCount(v) : String(v)}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      )}
      {status.note && <p className="mt-2 text-warn">{status.note}</p>}
    </aside>
  );
}

function ProvenanceTable({ checks }: { checks: ProvenanceCheck[] }) {
  if (checks.length === 0) {
    return <p className="mt-4 text-sm text-muted">No validation report is stored. Run <code className="font-mono text-[13px]">python -m ingestion.validate_provenance</code>.</p>;
  }
  const tally = (s: string) => checks.filter((c) => c.status === s).length;
  return (
    <div className="mt-4">
      <p className="text-sm">
        {tally("pass")} passed &middot; {tally("warn")} warnings &middot; {tally("fail")} failed &middot; {tally("skipped")} skipped
        {tally("skipped") > 0 && <span className="text-muted"> (a skipped check was not run, so it is not a pass)</span>}
      </p>
      <ScrollRegion label="Provenance validation checks" className="mt-2 border border-rule">
        <table className="w-full min-w-[480px] border-collapse text-sm">
          <caption className="sr-only">Provenance validation checks</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Check</th>
              <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Result</th>
              <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Detail</th>
              <th scope="col" className="border-b border-rule px-3 py-2 text-right font-semibold">Rows</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.name} className="border-b border-rule last:border-b-0">
                <td className="px-3 py-2 font-mono text-[13px]">{c.name}</td>
                <td className={`px-3 py-2 ${CHECK_TONE[c.status] ?? ""}`}>{c.status}</td>
                <td className="px-3 py-2 text-muted">{c.detail ?? ""}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.count ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}

function humanize(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
