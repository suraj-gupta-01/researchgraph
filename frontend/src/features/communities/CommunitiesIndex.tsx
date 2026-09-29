import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import EntityLink from "../../components/EntityLink";
import NoticeBar from "../../components/NoticeBar";
import NotComputed from "../../components/NotComputed";
import Pagination from "../../components/Pagination";
import { ApiError } from "../../api/client";
import { listCommunities, type CommunityPage, type CommunitySummary } from "../../api/communities";
import { formatCount } from "../../lib/format";
import { getNum, getStr, setNum } from "../../lib/urlState";

const PAGE_SIZE = 20;
const TOP_MEMBERS = 5;

/** /communities: F2's acceptance view. Scoped by the same top-bar `?q=` as
 * Explore (ScopeContext now treats this page as scope-aware); without a
 * scope this lists every detected community, largest first. */
export default function CommunitiesIndex() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = getStr(params, "q") ?? "";
  const offset = getNum(params, "offset") ?? 0;

  const [data, setData] = useState<CommunityPage | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [everRun, setEverRun] = useState<boolean | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError(null);
    listCommunities(q || undefined, TOP_MEMBERS, offset, PAGE_SIZE, ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [q, offset]);

  // A scoped, empty result could mean "nothing matched" or "graph.communities
  // hasn't run at all"; the unscoped count tells them apart, same trick as
  // the Trends board's other-direction check.
  const needsCheck = data !== null && data.total === 0 && q !== "";
  useEffect(() => {
    setEverRun(null);
    if (!needsCheck) return;
    const ctl = new AbortController();
    listCommunities(undefined, 0, 0, 1, ctl.signal)
      .then((r) => setEverRun(r.total > 0))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setEverRun(true); // unknown: don't wrongly claim it never ran
      });
    return () => ctl.abort();
  }, [needsCheck]);

  const patch = (mutate: (p: URLSearchParams) => void, keepOffset = false) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      if (!keepOffset) next.delete("offset");
      return next;
    });

  const scoped = q !== "";
  const columns: Column<CommunitySummary>[] = [
    {
      key: "label",
      label: "Community",
      render: (c) => (
        <span className={c.label ? "" : "italic text-muted"}>{c.label ?? `Community ${c.community_id}`}</span>
      ),
    },
    { key: "members", label: "Members", align: "right", render: (c) => formatCount(c.member_count) },
    { key: "papers", label: "Papers", align: "right", render: (c) => formatCount(c.paper_count) },
    ...(scoped
      ? ([
          { key: "matched_papers", label: "Matching papers", align: "right", render: (c) => formatCount(c.matched_papers ?? 0) } as Column<CommunitySummary>,
          { key: "matched_members", label: "Matching members", align: "right", render: (c) => formatCount(c.matched_members ?? 0) } as Column<CommunitySummary>,
        ])
      : []),
    {
      key: "top_members",
      label: "Top members",
      render: (c) => (
        <span className="text-sm" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {c.top_members.length === 0 ? (
            <span className="text-muted">&mdash;</span>
          ) : (
            c.top_members.map((m, i) => (
              <span key={m.author_id}>
                {i > 0 && ", "}
                <EntityLink kind="author" id={m.author_id}>
                  {m.full_name}
                </EntityLink>
              </span>
            ))
          )}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-[28px] font-semibold leading-tight">Research communities</h1>
        <Link to={q ? `/communities/graph?q=${encodeURIComponent(q)}` : "/communities/graph"} className="text-sm text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          View the collaboration graph
        </Link>
      </div>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        {scoped
          ? `Communities with at least one member who wrote a paper matching "${q}", ranked by how many matched.`
          : "Every detected community, largest first."}
      </p>

      {data?.search_meta && (data.search_meta as { truncated?: boolean }).truncated && (
        <NoticeBar kind="info">The search behind this topic scope hit its candidate limit; results may be incomplete.</NoticeBar>
      )}
      {data?.search_meta && (data.search_meta as { mongo?: string }).mongo === "unavailable" && (
        <NoticeBar kind="degraded">Abstract search is unavailable (MongoDB is down); results are from titles and topics only.</NoticeBar>
      )}

      {error && (
        <p role="alert" className="mt-5 text-sm text-warn">
          {error.kind === "network" ? `${error.message}. Start the stack with docker compose up -d, then reload.` : `Could not load communities (${error.message}).`}
        </p>
      )}

      {!data && !error && (
        <div aria-busy="true" className="mt-5 border border-rule">
          <p className="sr-only">Loading communities</p>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-[34px] border-b border-rule bg-rule/30 last:border-b-0" />
          ))}
        </div>
      )}

      {data && data.total === 0 && (
        <div className="mt-5">
          {!scoped ? (
            <NotComputed analysis="Research communities" command="python -m graph.communities" />
          ) : everRun === false ? (
            <NotComputed analysis="Research communities" command="python -m graph.communities" />
          ) : (
            <p className="max-w-xl text-sm">
              No community has a member who wrote a paper matching &ldquo;{q}&rdquo;.{" "}
              <button type="button" onClick={() => patch((p) => p.delete("q"))} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                Show every community
              </button>
              .
            </p>
          )}
        </div>
      )}

      {data && data.total > 0 && (
        <div className="mt-5">
          <DataTable
            columns={columns}
            rows={data.items}
            rowKey={(c) => c.community_id}
            caption={scoped ? `Communities matching "${q}"` : "Detected research communities"}
            onRowActivate={(c) => navigate(`/communities/${c.community_id}`)}
          />
          <Pagination offset={offset} limit={PAGE_SIZE} total={data.total} onPage={(o) => patch((p) => setNum(p, "offset", o || undefined), true)} />
        </div>
      )}
    </div>
  );
}
