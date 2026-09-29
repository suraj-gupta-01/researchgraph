import { useEffect, useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import EntityLink from "../../components/EntityLink";
import Pagination from "../../components/Pagination";
import NotFound from "../../app/NotFound";
import { ApiError } from "../../api/client";
import { paperDetail, paperCitations, citationChain, type PaperDetail, type CitationDirection, type CitationSort, type PaperSummary } from "../../api/papers";
import { buildChainTree, maxDepth, type ChainTreeNode } from "../../lib/tree";
import { formatDate, formatCount } from "../../lib/format";
import ScrollRegion from "../../components/ScrollRegion";
import ExternalLink from "../../components/ExternalLink";
import { sourceRecordUrl } from "../../lib/sources";

const PAGE_SIZE = 15;

function ChainList({ nodes }: { nodes: ChainTreeNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="ml-4 border-l border-rule pl-3">
      {nodes.map((n) => (
        <li key={n.paper_id} className="py-1">
          <EntityLink kind="paper" id={n.paper_id}>
            {n.title}
          </EntityLink>
          <span className="ml-1.5 text-sm text-muted">
            ({n.publication_year}, cited {formatCount(n.citation_count)} times)
          </span>
          {n.children.length > 0 && <ChainList nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

function CitationsPanel({ paperId }: { paperId: number }) {
  const [direction, setDirection] = useState<CitationDirection>("cited_by");
  const [sort, setSort] = useState<CitationSort>("citations");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ items: PaperSummary[]; total: number } | null>(null);

  useEffect(() => {
    setOffset(0);
  }, [direction, sort]);

  useEffect(() => {
    const ctl = new AbortController();
    paperCitations(paperId, direction, sort, offset, PAGE_SIZE, ctl.signal)
      .then((r) => setData({ items: r.items, total: r.total }))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setData({ items: [], total: 0 });
      });
    return () => ctl.abort();
  }, [paperId, direction, sort, offset]);

  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex border border-rule-strong text-sm">
          <button type="button" onClick={() => setDirection("cited_by")} className={`px-3 py-1.5 ${direction === "cited_by" ? "bg-accent text-white" : "bg-sheet hover:bg-accent-soft"}`}>
            Cited by
          </button>
          <button type="button" onClick={() => setDirection("cites")} className={`border-l border-rule-strong px-3 py-1.5 ${direction === "cites" ? "bg-accent text-white" : "bg-sheet hover:bg-accent-soft"}`}>
            Cites
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value as CitationSort)} className="rounded-sm border border-rule-strong bg-sheet px-2 py-1 text-ink">
            <option value="citations">Most cited</option>
            <option value="year">Newest</option>
            <option value="title">Title</option>
          </select>
        </label>
      </div>
      {data && data.items.length === 0 && <p className="text-sm text-muted">{direction === "cited_by" ? "No papers in this corpus cite this paper." : "This paper cites no papers in this corpus."}</p>}
      {data && data.items.length > 0 && (
        <>
          <ol className="border-t border-rule">
            {data.items.map((p) => (
              <li key={p.paper_id} className="border-b border-rule py-2.5">
                <EntityLink kind="paper" id={p.paper_id} className="font-serif text-base font-medium">
                  {p.title}
                </EntityLink>
                <p className="text-sm text-muted">
                  {p.authors.slice(0, 3).join(", ")}
                  {p.author_count > 3 ? " et al." : ""} &middot; {p.publication_year} &middot; cited {formatCount(p.citation_count)} times
                </p>
              </li>
            ))}
          </ol>
          <Pagination offset={offset} limit={PAGE_SIZE} total={data.total} onPage={setOffset} />
        </>
      )}
    </section>
  );
}

function ChainPanel({ paperId }: { paperId: number }) {
  const [direction, setDirection] = useState<CitationDirection>("cited_by");
  const [depth, setDepth] = useState(2);
  const [nodes, setNodes] = useState<ReturnType<typeof buildChainTree> | null>(null);
  const [flatCount, setFlatCount] = useState(0);
  const [depthReached, setDepthReached] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setNodes(null);
    citationChain(paperId, direction, depth, ctl.signal)
      .then((flat) => {
        setNodes(buildChainTree(flat, paperId));
        setFlatCount(flat.length);
        setDepthReached(maxDepth(flat));
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") {
          setNodes([]);
          setFlatCount(0);
        }
      });
    return () => ctl.abort();
  }, [paperId, direction, depth]);

  return (
    <section className="mt-8">
      <h2 className="font-serif text-lg font-semibold">Citation chain</h2>
      <p className="mt-1 text-sm text-muted">
        Follows {direction === "cited_by" ? "papers that cite this one, and papers that cite those" : "papers this one cites, and papers those cite"}, up to {depth} hops, within this corpus only.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
        <div className="inline-flex border border-rule-strong">
          <button type="button" onClick={() => setDirection("cited_by")} className={`px-3 py-1.5 ${direction === "cited_by" ? "bg-accent text-white" : "bg-sheet hover:bg-accent-soft"}`}>
            Cited by
          </button>
          <button type="button" onClick={() => setDirection("cites")} className={`border-l border-rule-strong px-3 py-1.5 ${direction === "cites" ? "bg-accent text-white" : "bg-sheet hover:bg-accent-soft"}`}>
            Cites
          </button>
        </div>
        <label className="flex items-center gap-2 text-muted">
          Depth
          <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="rounded-sm border border-rule-strong bg-sheet px-2 py-1 text-ink">
            <option value={1}>1 hop</option>
            <option value={2}>2 hops</option>
            <option value={3}>3 hops</option>
          </select>
        </label>
      </div>
      {nodes === null && <p className="mt-3 text-sm text-muted">Loading chain\u2026</p>}
      {nodes && nodes.length === 0 && <p className="mt-3 text-sm text-muted">No {direction === "cited_by" ? "citing" : "cited"} papers within this corpus.</p>}
      {nodes && nodes.length > 0 && (
        <div className="mt-3">
          <ChainList nodes={nodes} />
          {depthReached >= depth && (
            <p className="mt-2 text-sm text-muted">
              Chain truncated at depth {depth} ({flatCount} papers shown). Increase depth to follow it further.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default function PaperPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const paperId = Number(id);
  const [detail, setDetail] = useState<PaperDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!Number.isFinite(paperId)) return;
    const ctl = new AbortController();
    setDetail(null);
    setError(null);
    paperDetail(paperId, ctl.signal)
      .then(setDetail)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e);
      });
    return () => ctl.abort();
  }, [paperId]);

  if (!Number.isFinite(paperId)) return <NotFound message="That isn't a valid paper." />;
  if (error && error.kind === "http" && error.status === 404) return <NotFound message="This paper could not be found." />;
  if (error) return <p role="alert" className="py-10 text-warn">Could not load this paper ({error.message}).</p>;
  if (!detail) return <p className="py-10 text-sm text-muted">Loading paper\u2026</p>;

  const backScope = params.get("from");

  return (
    <article className="max-w-3xl pb-16">
      {backScope && (
        <p className="mb-4 text-sm">
          <Link to={`/explore?q=${encodeURIComponent(backScope)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
            &larr; Back to results for &ldquo;{backScope}&rdquo;
          </Link>
        </p>
      )}

      <h1 className="font-serif text-[28px] font-semibold leading-tight">{detail.title}</h1>
      <p className="mt-2 text-base text-muted">
        {detail.venue && (
          <EntityLink kind="venue" id={detail.venue.venue_id} className="text-inherit">
            {detail.venue.venue_name}
          </EntityLink>
        )}
        {detail.venue ? ", " : ""}
        {detail.publication_year} &middot; cited {formatCount(detail.citation_count)} times overall ({formatCount(detail.cited_by_in_corpus)} within this corpus) &middot; cites {formatCount(detail.cites_in_corpus)} papers in this corpus
        {detail.doi && (
          <>
            {" "}
            &middot;{" "}
            <a href={`https://doi.org/${detail.doi}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2" target="_blank" rel="noreferrer">
              doi:{detail.doi}
            </a>
          </>
        )}
      </p>

      <p className="mt-4 text-[15px] leading-relaxed">
        {detail.authors.map((a, i) => (
          <span key={a.author_id}>
            {i > 0 && ", "}
            <EntityLink kind="author" id={a.author_id}>
              {a.full_name}
            </EntityLink>
            {a.institutions.length > 0 && (
              <sup className="ml-0.5 text-xs text-muted">
                {a.institutions.map((inst, j) => (
                  <span key={inst.institution_id}>
                    {j > 0 && ","} <EntityLink kind="institution" id={inst.institution_id}>{inst.name}</EntityLink>
                  </span>
                ))}
              </sup>
            )}
          </span>
        ))}
      </p>

      {detail.abstract ? (
        <p className="mt-5 max-w-[62ch] text-[17px] leading-relaxed">{detail.abstract}</p>
      ) : (
        <p className="mt-5 text-sm text-muted">{detail.text_status === "unavailable" ? "The abstract store is unreachable right now, so no abstract is shown." : "No abstract was provided by the sources."}</p>
      )}

      {detail.keywords.length > 0 && (
        <p className="mt-4 flex flex-wrap gap-1.5">
          {detail.keywords.map((k) => (
            <Link key={k} to={`/explore?q=${encodeURIComponent(k)}`} className="border border-rule-strong bg-sheet px-2.5 py-0.5 text-sm hover:bg-accent-soft">
              {k}
            </Link>
          ))}
        </p>
      )}

      {detail.topics.length > 0 && (
        <section className="mt-6">
          <h2 className="font-serif text-lg font-semibold">Topics</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.topics
              .slice()
              .sort((a, b) => b.relevance_score - a.relevance_score)
              .map((t) => (
                <li key={t.topic_id} className="flex items-baseline justify-between gap-3">
                  <EntityLink kind="topic" id={t.topic_id}>
                    {t.topic_name}
                  </EntityLink>
                  <span className="tabular-nums text-muted">
                    relevance {t.relevance_score.toFixed(2)}
                    {t.extraction_method ? ` \u00b7 ${t.extraction_method}` : ""}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="font-serif text-lg font-semibold">Sources</h2>
        <p className="mt-1 text-sm text-muted">Every fact on this page traces back to at least one of these records.</p>
        <ScrollRegion label="Source provenance" className="mt-2 border border-rule">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="bg-sheet">
                <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Source</th>
                <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Record ID</th>
                <th scope="col" className="border-b border-rule px-3 py-2 text-right font-semibold">Citation count reported</th>
                <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Fetched</th>
              </tr>
            </thead>
            <tbody>
              {detail.sources.map((s) => (
                <tr key={`${s.source_name}-${s.source_record_id}`} className="border-b border-rule last:border-b-0">
                  <td className="px-3 py-2 capitalize">{s.source_name}</td>
                  <td className="px-3 py-2 font-mono text-[13px]">
                    {sourceRecordUrl(s.source_name, s.source_record_id) ? (
                      <ExternalLink href={sourceRecordUrl(s.source_name, s.source_record_id)!}>{s.source_record_id}</ExternalLink>
                    ) : (
                      s.source_record_id
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.source_citation_count === null ? "\u2014" : formatCount(s.source_citation_count)}</td>
                  <td className="px-3 py-2">{formatDate(s.fetched_at)}</td>
                </tr>
              ))}
              {detail.sources.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-center text-muted">
                    No source records.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <CitationsPanel paperId={paperId} />
      <ChainPanel paperId={paperId} />
    </article>
  );
}
