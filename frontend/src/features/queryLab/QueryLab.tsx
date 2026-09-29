import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import EntityLink from "../../components/EntityLink";
import EntityPicker from "../../components/EntityPicker";
import Pagination from "../../components/Pagination";
import { ApiError } from "../../api/client";
import { listCommunities, type CommunitySummary } from "../../api/communities";
import { citationChain, listPapers } from "../../api/papers";
import {
  crossCommunityCitations,
  institutionTopicCollaboration,
  queryCatalog,
  topicAuthors,
  topicYearCounts,
  type QueryCatalogEntry,
} from "../../api/queries";
import { listTopics } from "../../api/topics";
import { formatCount } from "../../lib/format";
import { buildChainTree, type ChainNode, type ChainTreeNode } from "../../lib/tree";
import { getNum, getRef, getStr, setNum, setRef } from "../../lib/urlState";
import ScrollRegion from "../../components/ScrollRegion";

const PAGE = 20;

type Params = URLSearchParams;
type Patch = (mutate: (p: Params) => void, resetPage?: boolean) => void;

const searchTopics = (q: string, signal: AbortSignal) =>
  listTopics(q, undefined, 0, 10, signal).then((r) => r.items.map((t) => ({ id: t.topic_id, name: t.topic_name })));
const searchPapers = (q: string, signal: AbortSignal) =>
  listPapers({ q }, "citations", 0, 10, signal).then((r) => r.items.map((p) => ({ id: p.paper_id, name: `${p.title} (${p.publication_year})` })));

/** /query-lab (G6, analyst role): the PRD Section 9 demo queries as named,
 * parameterized screens. Each runs one /queries/* endpoint (or, for the
 * recursive chain, /papers/{id}/citation-chain) and shows, beside the
 * result, the statement the endpoint executes and the live definitions of
 * the views/functions it reads, from /queries/catalog -- the evaluator can
 * read exactly what Postgres ran. Query choice and parameters live in the
 * URL, so a demo step is a link. */
export default function QueryLab() {
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<QueryCatalogEntry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    queryCatalog(ctl.signal)
      .then(setCatalog)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, []);

  const key = getStr(params, "query") ?? "topic-authors";
  const entry = catalog?.find((c) => c.key === key) ?? catalog?.[0];

  const patch: Patch = (mutate, resetPage = true) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        if (resetPage) next.delete("offset");
        return next;
      },
      { replace: true },
    );

  return (
    <div className="pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">Query lab</h1>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        The PRD&rsquo;s Section 9 queries against the live database. Each shows its result next to the SQL that produced it: the exact statement, and the stored views and functions it reads.
      </p>

      {error && <p role="alert" className="mt-5 text-sm text-warn">Could not load the query catalog ({error.message}).</p>}
      {!catalog && !error && <p className="mt-5 text-sm text-muted">Loading&hellip;</p>}

      {catalog && entry && (
        <>
          <div role="tablist" aria-label="Queries" className="mt-5 flex flex-wrap gap-1 border-b border-rule">
            {catalog.map((c) => (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={c.key === entry.key}
                onClick={() => setParams({ query: c.key })}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${c.key === entry.key ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-ink"}`}
              >
                {c.title}
              </button>
            ))}
          </div>

          <section role="tabpanel" aria-label={entry.title} className="mt-5">
            <p className="font-serif text-lg">&ldquo;{entry.prd_text}&rdquo;</p>
            <p className="mt-1 text-sm text-muted">
              {entry.kind} &middot; <code className="font-mono text-[13px]">{entry.endpoint}</code>
            </p>
            <div className="mt-4 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <QueryRunner queryKey={entry.key} params={params} patch={patch} />
              </div>
              <SqlPanel entry={entry} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function SqlPanel({ entry }: { entry: QueryCatalogEntry }) {
  return (
    <aside aria-label="SQL" className="min-w-0 self-start border border-rule-strong bg-sheet p-4">
      <h2 className="text-sm font-semibold">Statement the endpoint runs</h2>
      <ScrollRegion as="pre" label="SQL statement" className="mt-2 whitespace-pre text-[12.5px] leading-relaxed"><code>{entry.statement}</code></ScrollRegion>
      {entry.objects.map((o) => (
        <details key={o.name} className="mt-3 border-t border-rule pt-2" open={entry.objects.length === 1}>
          <summary className="cursor-pointer text-sm">
            {o.kind} <code className="font-mono text-[13px]">{o.name}</code>
          </summary>
          <ScrollRegion as="pre" label={`Definition of ${o.name}`} className="mt-2 whitespace-pre text-[12.5px] leading-relaxed"><code>{o.definition}</code></ScrollRegion>
        </details>
      ))}
      <p className="mt-3 text-xs text-muted">Parameters (:name) are bound by the driver, never spliced into the SQL.</p>
    </aside>
  );
}

// ---- per-query runners --------------------------------------------------------

function QueryRunner({ queryKey, params, patch }: { queryKey: string; params: Params; patch: Patch }) {
  switch (queryKey) {
    case "topic-authors":
      return <TopicAuthors params={params} patch={patch} />;
    case "cross-community-citations":
      return <CrossCommunity params={params} patch={patch} />;
    case "institution-topic-collaboration":
      return <InstitutionTopics params={params} patch={patch} />;
    case "topic-year-counts":
      return <TopicYears params={params} patch={patch} />;
    case "citation-chain":
      return <Chain params={params} patch={patch} />;
    default:
      return <p className="text-sm text-muted">This query has no runner yet.</p>;
  }
}

/** Fetch whenever `deps` change and `ready` holds; one state object. */
function useQuery<T>(ready: boolean, load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!ready) return;
    const ctl = new AbortController();
    setLoading(true);
    load(ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      })
      .finally(() => setLoading(false));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading };
}

function Status({ loading, error, prompt, ready }: { loading: boolean; error: ApiError | null; prompt: string; ready: boolean }) {
  if (!ready) return <p className="mt-4 text-sm text-muted">{prompt}</p>;
  if (loading) return <p className="mt-4 text-sm text-muted">Running&hellip;</p>;
  if (error) {
    const detail = (error.detail as { detail?: unknown } | undefined)?.detail;
    return (
      <p role="alert" className="mt-4 text-sm text-warn">
        {typeof detail === "string" ? detail : `The query failed (${error.message}).`}
      </p>
    );
  }
  return null;
}

function Table({ head, children, caption }: { head: { label: string; right?: boolean }[]; children: ReactNode; caption: string }) {
  return (
    <ScrollRegion label={caption} className="mt-4 border border-rule">
      <table className="w-full min-w-[480px] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={`${h.label}-${i}`} scope="col" className={`border-b border-rule px-3 py-2 font-semibold ${h.right ? "text-right" : "text-left"}`}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </ScrollRegion>
  );
}

const td = "border-b border-rule px-3 py-2 align-top";

function YearInput({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <label className="flex flex-col text-sm">
      {label}
      <input
        type="number"
        inputMode="numeric"
        min={1900}
        max={2100}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="mt-1 w-24 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5"
      />
    </label>
  );
}

function TopicAuthors({ params, patch }: { params: Params; patch: Patch }) {
  const topic = getRef(params, "topic", "topicName");
  const from = getNum(params, "from") ?? 2023;
  const to = getNum(params, "to") ?? 2025;
  const offset = getNum(params, "offset") ?? 0;
  const ready = !!topic;
  const { data, error, loading } = useQuery(ready, (s) => topicAuthors(topic!.id, from, to, offset, PAGE, s), [topic?.id, from, to, offset]);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <EntityPicker label="Topic" value={topic} onChange={(v) => patch((p) => setRef(p, "topic", "topicName", v))} search={searchTopics} placeholder="e.g. federated learning" />
        <YearInput label="From year" value={from} onChange={(v) => patch((p) => setNum(p, "from", v))} />
        <YearInput label="To year" value={to} onChange={(v) => patch((p) => setNum(p, "to", v))} />
      </div>
      <Status ready={ready} loading={loading} error={error} prompt="Choose a topic to run the query." />
      {data && (
        <>
          <p className="mt-4 text-sm">
            {formatCount(data.total)} authors published on {topic!.name} from {from} to {to} (sub-topics included).
          </p>
          {data.total > 0 && (
            <>
              <Table caption="Authors on the topic" head={[{ label: "Author" }, { label: "Papers", right: true }, { label: "Years" }, { label: "Institutions" }]}>
                {data.items.map((r) => (
                  <tr key={r.author_id}>
                    <td className={td}><EntityLink kind="author" id={r.author_id}>{r.full_name}</EntityLink></td>
                    <td className={`${td} text-right tabular-nums`}>{r.paper_count}</td>
                    <td className={`${td} tabular-nums`}>{r.first_year === r.last_year ? r.first_year : `${r.first_year} to ${r.last_year}`}</td>
                    <td className={td}>{r.institutions.length ? r.institutions.join("; ") : <span className="text-muted">None recorded</span>}</td>
                  </tr>
                ))}
              </Table>
              <Pagination offset={offset} limit={PAGE} total={data.total} onPage={(o) => patch((p) => setNum(p, "offset", o || undefined), false)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function CrossCommunity({ params, patch }: { params: Params; patch: Patch }) {
  const community = getNum(params, "community");
  const offset = getNum(params, "offset") ?? 0;
  const [communities, setCommunities] = useState<CommunitySummary[]>([]);
  useEffect(() => {
    const ctl = new AbortController();
    listCommunities(undefined, 0, 0, 100, ctl.signal).then((r) => setCommunities(r.items)).catch(() => setCommunities([]));
    return () => ctl.abort();
  }, []);
  const { data, error, loading } = useQuery(true, (s) => crossCommunityCitations(community, offset, PAGE, s), [community, offset]);
  const label = (id: number, l: string | null) => l ?? `Community ${id}`;

  return (
    <div>
      <label className="flex flex-col text-sm">
        Community (either side)
        <select
          value={community ?? ""}
          onChange={(e) => patch((p) => setNum(p, "community", e.target.value ? Number(e.target.value) : undefined))}
          className="mt-1 w-72 max-w-full rounded-sm border border-rule-strong bg-sheet px-2 py-1.5"
        >
          <option value="">All communities</option>
          {communities.map((c) => (
            <option key={c.community_id} value={c.community_id}>
              {label(c.community_id, c.label)}
            </option>
          ))}
        </select>
      </label>
      <Status ready loading={loading} error={error} prompt="" />
      {data && data.total === 0 && (
        <p className="mt-4 text-sm text-muted">
          No cross-community citations. If communities have not been detected yet, run <code className="font-mono text-[13px]">python -m graph.communities</code> first: a paper&rsquo;s community comes from its authors&rsquo;.
        </p>
      )}
      {data && data.total > 0 && (
        <>
          <p className="mt-4 text-sm">{formatCount(data.total)} citations cross a community boundary. A paper belongs to its authors&rsquo; majority community.</p>
          <Table caption="Cross-community citations" head={[{ label: "Citing paper" }, { label: "Its community" }, { label: "Cites" }, { label: "Its community" }]}>
            {data.items.map((r) => (
              <tr key={`${r.citing_paper_id}-${r.cited_paper_id}`}>
                <td className={td}><EntityLink kind="paper" id={r.citing_paper_id}>{r.citing_title}</EntityLink> <span className="text-muted">({r.citing_year})</span></td>
                <td className={td}><EntityLink kind="community" id={r.citing_community_id}>{label(r.citing_community_id, r.citing_community_label)}</EntityLink></td>
                <td className={td}><EntityLink kind="paper" id={r.cited_paper_id}>{r.cited_title}</EntityLink> <span className="text-muted">({r.cited_year})</span></td>
                <td className={td}><EntityLink kind="community" id={r.cited_community_id}>{label(r.cited_community_id, r.cited_community_label)}</EntityLink></td>
              </tr>
            ))}
          </Table>
          <Pagination offset={offset} limit={PAGE} total={data.total} onPage={(o) => patch((p) => setNum(p, "offset", o || undefined), false)} />
        </>
      )}
    </div>
  );
}

function InstitutionTopics({ params, patch }: { params: Params; patch: Patch }) {
  const a = getRef(params, "a", "aName");
  const b = getRef(params, "b", "bName");
  const offset = getNum(params, "offset") ?? 0;
  const same = !!a && !!b && a.id === b.id;
  const ready = !!a && !!b && !same;
  const { data, error, loading } = useQuery(ready, (s) => institutionTopicCollaboration(a!.id, b!.id, offset, PAGE, s), [a?.id, b?.id, offset]);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <EntityPicker label="First topic" value={a} onChange={(v) => patch((p) => setRef(p, "a", "aName", v))} search={searchTopics} />
        <EntityPicker label="Second topic" value={b} onChange={(v) => patch((p) => setRef(p, "b", "bName", v))} search={searchTopics} />
      </div>
      {same ? (
        <p role="alert" className="mt-4 text-sm text-warn">Choose two different topics.</p>
      ) : (
        <Status ready={ready} loading={loading} error={error} prompt="Choose two topics. The Interdisciplinary connections board lists pairs that often appear together." />
      )}
      {data && data.total === 0 && <p className="mt-4 text-sm text-muted">No institution pair co-authored a paper tagged with both topics.</p>}
      {data && data.total > 0 && (
        <>
          <p className="mt-4 text-sm">
            {formatCount(data.total)} institution pairs co-authored papers tagged with both {a!.name} and {b!.name}.
          </p>
          <Table caption="Institution pairs" head={[{ label: "Institution" }, { label: "Institution" }, { label: "Shared papers", right: true }, { label: "Examples" }]}>
            {data.items.map((r) => (
              <tr key={`${r.institution_a_id}-${r.institution_b_id}`}>
                <td className={td}><EntityLink kind="institution" id={r.institution_a_id}>{r.institution_a_name}</EntityLink>{r.institution_a_country && <span className="text-muted"> ({r.institution_a_country})</span>}</td>
                <td className={td}><EntityLink kind="institution" id={r.institution_b_id}>{r.institution_b_name}</EntityLink>{r.institution_b_country && <span className="text-muted"> ({r.institution_b_country})</span>}</td>
                <td className={`${td} text-right tabular-nums`}>{r.shared_papers}</td>
                <td className={td}>
                  {r.example_paper_ids.map((pid, i) => (
                    <span key={pid}>
                      {i > 0 && ", "}
                      <EntityLink kind="paper" id={pid}>{`paper ${pid}`}</EntityLink>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </Table>
          <Pagination offset={offset} limit={PAGE} total={data.total} onPage={(o) => patch((p) => setNum(p, "offset", o || undefined), false)} />
        </>
      )}
    </div>
  );
}

function TopicYears({ params, patch }: { params: Params; patch: Patch }) {
  const topic = getRef(params, "topic", "topicName");
  const { data, error, loading } = useQuery(!!topic, (s) => topicYearCounts(topic!.id, s), [topic?.id]);
  const max = Math.max(1, ...(data ?? []).map((r) => r.paper_count));
  return (
    <div>
      <EntityPicker label="Topic" value={topic} onChange={(v) => patch((p) => setRef(p, "topic", "topicName", v))} search={searchTopics} />
      <Status ready={!!topic} loading={loading} error={error} prompt="Choose a topic to run the query." />
      {data && data.length === 0 && <p className="mt-4 text-sm text-muted">No paper is tagged with this topic.</p>}
      {data && data.length > 0 && (
        <>
          <p className="mt-4 text-sm">Every paper tagged with {topic!.name}, at any relevance, grouped by publication year. Years with no papers have no row.</p>
          <Table caption="Papers per year" head={[{ label: "Year" }, { label: "Papers", right: true }, { label: "" }, { label: "Citations", right: true }]}>
            {data.map((r) => (
              <tr key={r.year}>
                <td className={`${td} tabular-nums`}>{r.year}</td>
                <td className={`${td} text-right tabular-nums`}>{r.paper_count}</td>
                <td className={`${td} w-1/2`}>
                  <div aria-hidden="true" className="h-3 bg-bar" style={{ width: `${(r.paper_count / max) * 100}%` }} />
                </td>
                <td className={`${td} text-right tabular-nums`}>{formatCount(r.citation_count)}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}

function Chain({ params, patch }: { params: Params; patch: Patch }) {
  const paper = getRef(params, "paper", "paperName");
  const direction = getStr(params, "dir") === "cited_by" ? "cited_by" : "cites";
  const depth = Math.min(5, Math.max(1, getNum(params, "depth") ?? 3));
  const { data, error, loading } = useQuery<ChainNode[]>(!!paper, (s) => citationChain(paper!.id, direction, depth, s), [paper?.id, direction, depth]);
  const tree = data && paper ? buildChainTree(data, paper.id) : [];
  const reached = data ? Math.max(0, ...data.map((n) => n.depth)) : 0;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <EntityPicker label="Starting paper" value={paper} onChange={(v) => patch((p) => setRef(p, "paper", "paperName", v))} search={searchPapers} placeholder="Search paper titles" />
        <label className="flex flex-col text-sm">
          Direction
          <select value={direction} onChange={(e) => patch((p) => p.set("dir", e.target.value))} className="mt-1 rounded-sm border border-rule-strong bg-sheet px-2 py-1.5">
            <option value="cites">Papers it cites, and theirs</option>
            <option value="cited_by">Papers citing it, and theirs</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Depth
          <select value={depth} onChange={(e) => patch((p) => setNum(p, "depth", Number(e.target.value)))} className="mt-1 rounded-sm border border-rule-strong bg-sheet px-2 py-1.5">
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
      </div>
      <Status ready={!!paper} loading={loading} error={error} prompt="Choose a paper to walk its citation chain." />
      {data && data.length === 0 && <p className="mt-4 text-sm text-muted">{direction === "cites" ? "This paper cites no paper in the corpus." : "No paper in the corpus cites this one."}</p>}
      {data && data.length > 0 && (
        <>
          <p className="mt-4 text-sm">
            {formatCount(data.length)} papers reached in {reached} {reached === 1 ? "step" : "steps"}
            {reached >= depth && `; the chain may continue past depth ${depth}`}. Each paper appears once, at its shortest distance.
          </p>
          <ul className="mt-3 border border-rule bg-sheet p-3 text-sm" aria-label="Citation chain">
            <ChainList nodes={tree} />
          </ul>
        </>
      )}
    </div>
  );
}

function ChainList({ nodes }: { nodes: ChainTreeNode[] }) {
  return (
    <>
      {nodes.map((n) => (
        <li key={n.paper_id} className="py-0.5">
          <span className="mr-1.5 text-muted tabular-nums">{n.depth}</span>
          <EntityLink kind="paper" id={n.paper_id}>{n.title}</EntityLink> <span className="text-muted">({n.publication_year})</span>
          {n.children.length > 0 && (
            <ul className="border-l border-rule pl-5">
              <ChainList nodes={n.children} />
            </ul>
          )}
        </li>
      ))}
    </>
  );
}

