import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { searchOverview, searchPapers, type SearchFilters, type SearchOverview, type PaperSort, type PaperSummary } from "../../api/search";
import { ApiError, API_URL } from "../../api/client";
import { getNum, getRef, setNum, setRef, type EntityRef } from "../../lib/urlState";
import { listTopics } from "../../api/topics";
import YearBrush from "../../components/YearBrush";
import Facet from "../../components/Facet";
import NoticeBar from "../../components/NoticeBar";
import { useScope } from "../../app/ScopeContext";
import ResultList from "./ResultList";
import PaperPeek from "./PaperPeek";

const PAGE_SIZE = 20;
const EXAMPLE_FALLBACK = ["federated learning", "graph neural networks", "large language models"];

function readFilters(params: URLSearchParams): SearchFilters {
  return {
    q: params.get("q") ?? "",
    yearFrom: getNum(params, "from"),
    yearTo: getNum(params, "to"),
    author: getRef(params, "author", "authorName"),
    institution: getRef(params, "inst", "instName"),
    venue: getRef(params, "venue", "venueName"),
  };
}

/** Just the filter half of a SearchFilters, as a query string — for links
 * to another scoped page (e.g. /explore/network) that shouldn't also carry
 * this page's own sort/offset/paper-selection state. */
function filterQuery(f: SearchFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  setNum(p, "from", f.yearFrom);
  setNum(p, "to", f.yearTo);
  setRef(p, "author", "authorName", f.author);
  setRef(p, "inst", "instName", f.institution);
  setRef(p, "venue", "venueName", f.venue);
  return p.toString();
}

export default function Explore() {
  const [params, setParams] = useSearchParams();
  const { submitScope } = useScope();
  const f = readFilters(params);
  const sort = (params.get("sort") as PaperSort) ?? "relevance";
  const offset = getNum(params, "offset") ?? 0;
  const selectedPaper = getNum(params, "paper");

  const [overview, setOverview] = useState<SearchOverview | null>(null);
  const [papers, setPapers] = useState<{ items: PaperSummary[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [examples, setExamples] = useState<string[]>(EXAMPLE_FALLBACK);

  const filterKey = JSON.stringify(f);

  // No-scope landing: pull real example topics (sorted by paper count) rather than hard-coded strings.
  useEffect(() => {
    if (f.q) return;
    const ctl = new AbortController();
    listTopics(undefined, undefined, 0, 6, ctl.signal)
      .then((r) => {
        if (r.items.length > 0) setExamples(r.items.map((t) => t.topic_name));
      })
      .catch(() => {});
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.q]);

  useEffect(() => {
    if (!f.q) {
      setOverview(null);
      return;
    }
    const ctl = new AbortController();
    setError(null);
    searchOverview(f, ctl.signal)
      .then(setOverview)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(() => {
    if (!f.q) {
      setPapers(null);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    searchPapers(f, sort, offset, PAGE_SIZE, ctl.signal)
      .then((r) => {
        setPapers({ items: r.items, total: r.total });
        setLoading(false);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e);
          setLoading(false);
        }
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, sort, offset]);

  const patch = (mutate: (p: URLSearchParams) => void, resetPage = true) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      if (resetPage) next.delete("offset");
      return next;
    });
  };
  const setYear = (from?: number, to?: number) =>
    patch((p) => {
      setNum(p, "from", from);
      setNum(p, "to", to);
    });
  const setAuthorFilter = (v?: EntityRef) => patch((p) => setRef(p, "author", "authorName", v));
  const setInstitutionFilter = (v?: EntityRef) => patch((p) => setRef(p, "inst", "instName", v));
  const setVenueFilter = (v?: EntityRef) => patch((p) => setRef(p, "venue", "venueName", v));
  const setSort = (s: PaperSort) => patch((p) => p.set("sort", s));
  const setPage = (off: number) => {
    patch((p) => setNum(p, "offset", off || undefined), false);
    window.scrollTo({ top: 0 });
  };
  const selectPaper = (id?: number) => patch((p) => setNum(p, "paper", id), false);

  const hasFilters = !!(f.yearFrom || f.author || f.institution || f.venue);
  const noMatches = overview && overview.summary.papers === 0;
  const s = overview?.summary;
  const span = s?.year_min && s.year_max ? (s.year_min === s.year_max ? `${s.year_min}` : `${s.year_min} to ${s.year_max}`) : null;

  return (
    <div>
      {error && (
        <div role="alert" className="mb-4 border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
          {error.kind === "network" ? (
            <>
              The dashboard cannot reach the API at {API_URL}. Start the stack with <code className="font-mono">docker compose up -d</code> and reload.
            </>
          ) : error.status === 422 ? (
            <>That query is too long. Try fewer words.</>
          ) : (
            <>
              The API returned an error ({error.message}). Check the backend logs with <code className="font-mono">docker compose logs backend</code>.
            </>
          )}
        </div>
      )}

      {!f.q && (
        <section className="max-w-xl py-10">
          <h1 className="font-serif text-[36px] font-semibold leading-tight">Explore a research topic</h1>
          <p className="mt-3 text-base leading-relaxed text-muted">
            Search a topic to see its papers, the authors, institutions and venues behind them, and how publication volume changed year by year.
          </p>
          <p className="mt-5 flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button key={ex} type="button" onClick={() => submitScope(ex)} className="border border-rule-strong bg-sheet px-3.5 py-1.5 text-sm hover:bg-accent-soft">
                {ex}
              </button>
            ))}
          </p>
          <p className="mt-6 text-sm text-muted">
            No results for any topic? The database may be empty. Load data with <code className="font-mono">python -m ingestion.run_ingestion</code>, or{" "}
            <code className="font-mono">python -m ingestion.seed_dev</code> for a synthetic set.
          </p>
        </section>
      )}

      {f.q && (
        <>
          {overview?.meta.mongo === "unavailable" && <NoticeBar kind="degraded">Abstract search is offline, so results come from titles and topic tags only, and related keywords are hidden.</NoticeBar>}
          {overview?.meta.truncated && <NoticeBar kind="degraded">This search matched more papers than can be ranked at once, so lower-ranked matches are missing. Add words to narrow the topic.</NoticeBar>}

          {overview && !noMatches && (
            <section className="mb-6 grid grid-cols-1 gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div>
                <h2 className="font-serif text-2xl font-semibold leading-snug">
                  {s!.papers.toLocaleString()} papers on &ldquo;{overview.query}&rdquo;
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {s!.authors.toLocaleString()} authors at {s!.institutions.toLocaleString()} institutions{span ? `, published ${span}` : ""}.{" "}
                  {s!.citation_edges.toLocaleString()} citations link these papers to each other.
                </p>
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-muted hover:text-ink">How results are ranked</summary>
                  <p className="mt-1 max-w-md border-l-2 border-rule pl-3 text-muted">
                    Relevance is 3 &times; a title match, plus 2 &times; a topic match, plus 1 &times; an abstract or keyword match, ties broken by citation count. Abstract matching requires every search term.
                  </p>
                </details>
                <p className="mt-2 text-sm">
                  <Link to={`/explore/network?${filterQuery(f)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                    View the citation network
                  </Link>
                </p>
                {hasFilters && (
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    {f.yearFrom && <Chip label={f.yearFrom === f.yearTo ? `Year ${f.yearFrom}` : `Years ${f.yearFrom} to ${f.yearTo}`} onRemove={() => setYear(undefined, undefined)} />}
                    {f.author && <Chip label={`Author ${f.author.name}`} onRemove={() => setAuthorFilter(undefined)} />}
                    {f.institution && <Chip label={f.institution.name} onRemove={() => setInstitutionFilter(undefined)} />}
                    {f.venue && <Chip label={f.venue.name} onRemove={() => setVenueFilter(undefined)} />}
                  </p>
                )}
              </div>
              <div>
                <p className="mb-1 text-sm text-muted">Papers per year. Select a year, or two years to select the span between them.</p>
                <YearBrush histogram={overview.year_histogram} from={f.yearFrom} to={f.yearTo} onChange={setYear} />
              </div>
            </section>
          )}

          {noMatches && (
            <section className="max-w-xl py-8">
              <h2 className="font-serif text-2xl font-semibold">{hasFilters ? "No papers match these filters" : `No papers match \u201c${f.q}\u201d`}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {hasFilters ? "Remove a filter to widen the search." : "Try fewer or broader words. If every search comes back empty, the database has no papers yet; run the ingestion described in the README."}
              </p>
              {hasFilters && (
                <p className="mt-3 flex flex-wrap gap-2 text-sm">
                  {f.yearFrom && <Chip label="Years" onRemove={() => setYear(undefined, undefined)} />}
                  {f.author && <Chip label={`Author ${f.author.name}`} onRemove={() => setAuthorFilter(undefined)} />}
                  {f.institution && <Chip label={f.institution.name} onRemove={() => setInstitutionFilter(undefined)} />}
                  {f.venue && <Chip label={f.venue.name} onRemove={() => setVenueFilter(undefined)} />}
                </p>
              )}
            </section>
          )}

          {overview && !noMatches && (
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[250px_minmax(0,1fr)]">
              <div>
                <Facet
                  title="Authors"
                  items={overview.top_authors.map((a) => ({
                    key: a.author_id,
                    label: a.full_name,
                    note: `${a.total_citations.toLocaleString()} citations`,
                    count: a.paper_count,
                    onClick: () => setAuthorFilter({ id: a.author_id, name: a.full_name }),
                  }))}
                />
                <Facet
                  title="Institutions"
                  items={overview.top_institutions.map((i) => ({
                    key: i.institution_id,
                    label: i.name,
                    note: i.country ?? undefined,
                    count: i.paper_count,
                    onClick: () => setInstitutionFilter({ id: i.institution_id, name: i.name }),
                  }))}
                />
                <Facet
                  title="Venues"
                  items={overview.top_venues.map((v) => ({
                    key: v.venue_id,
                    label: v.venue_name,
                    count: v.paper_count,
                    onClick: () => setVenueFilter({ id: v.venue_id, name: v.venue_name }),
                  }))}
                />
                <Facet
                  title="Related keywords"
                  empty={overview.meta.mongo === "unavailable" ? "Unavailable while abstract search is offline." : "No keywords recorded for these papers."}
                  items={overview.keywords.map((k) => ({ key: k.keyword, label: k.keyword, count: k.paper_count, onClick: () => submitScope(k.keyword) }))}
                />
                <Facet title="Topics" empty="Topic tags appear once topic extraction has run." items={overview.topics.map((t) => ({ key: t.topic_id, label: t.topic_name, count: t.paper_count }))} />
              </div>

              <div>
                {papers && (
                  <ResultList
                    items={papers.items}
                    total={papers.total}
                    offset={offset}
                    limit={PAGE_SIZE}
                    selected={selectedPaper}
                    loading={loading}
                    sort={sort}
                    onSort={setSort}
                    onSelect={(id) => selectPaper(id)}
                    onPage={setPage}
                  />
                )}
              </div>
            </div>
          )}

          {!overview && !error && <p className="py-8 text-sm text-muted">Searching\u2026</p>}
        </>
      )}

      <PaperPeek paperId={selectedPaper ?? null} onClose={() => selectPaper(undefined)} onKeyword={(kw) => submitScope(kw)} />
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 bg-accent-soft py-0.5 pl-3 pr-1 text-sm">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter: ${label}`} className="px-2 py-0.5 hover:bg-accent hover:text-white">
        &times;
      </button>
    </span>
  );
}
