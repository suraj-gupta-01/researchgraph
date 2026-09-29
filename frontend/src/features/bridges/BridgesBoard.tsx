import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import TieProfileChart, { type CommunityKey } from "../../charts/TieProfileChart";
import DataTable, { type Column } from "../../components/DataTable";
import Drawer from "../../components/Drawer";
import EntityLink from "../../components/EntityLink";
import Figure from "../../components/Figure";
import NoticeBar from "../../components/NoticeBar";
import NotComputed from "../../components/NotComputed";
import Pagination from "../../components/Pagination";
import { ApiError } from "../../api/client";
import { listBridgeAuthors, type BridgeAuthor, type BridgePage } from "../../api/authors";
import { listCommunities } from "../../api/communities";
import InfluencePanel from "../authors/InfluencePanel";
import { formatCount, formatScore } from "../../lib/format";
import { communityKeys, isNotComputed, isValidMinCommunities, MIN_COMMUNITIES_DEFAULT, MIN_COMMUNITIES_RANGE } from "../../lib/bridges";
import { getNum, getRef, getStr, setNum, setRef, type EntityRef } from "../../lib/urlState";

const PAGE_SIZE = 25;

function ScoreCell({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-14 bg-rule" aria-hidden="true">
        <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular-nums text-muted">{formatScore(value)}</span>
    </span>
  );
}

/** The community receiving the largest share of an author's ties. */
function mainTie(a: BridgeAuthor) {
  return a.ties.reduce<BridgeAuthor["ties"][number] | null>((best, t) => (best === null || t.share > best.share ? t : best), null);
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "bridge-researchers"
  );
}

/** /bridges: F4's acceptance view -- "for a searched topic, researchers who
 * publish across the topic's communities, ranked by bridge score"
 * (references/phases.md Phase 5). Scoped by the same top-bar `?q=` as
 * Explore and Communities; without a scope, every researcher touching
 * `min_communities` or more of the currently detected communities,
 * corpus-wide. */
export default function BridgesBoard() {
  const [params, setParams] = useSearchParams();
  const q = getStr(params, "q") ?? "";
  const minCommunities = getNum(params, "min_communities") ?? MIN_COMMUNITIES_DEFAULT;
  const offset = getNum(params, "offset") ?? 0;
  const selected = getRef(params, "author", "authorName");

  const [data, setData] = useState<BridgePage | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [minDraft, setMinDraft] = useState(String(minCommunities));
  // The per-community comparison chart is opt-in: the table answers the
  // page's question on its own, and 25 multi-colour bars at once is a lot.
  const [showProfiles, setShowProfiles] = useState(false);

  useEffect(() => setMinDraft(String(minCommunities)), [minCommunities]);

  // Community names and colours for the tie-profile chart. Corpus-wide (not
  // scoped by ?q=), so a community keeps the colour it has on the
  // Communities pages. 100 is the API's page cap; a run keeps far fewer.
  const [communities, setCommunities] = useState<CommunityKey[]>([]);
  useEffect(() => {
    const ctl = new AbortController();
    listCommunities(undefined, 0, 0, 100, ctl.signal)
      .then((r) => setCommunities(communityKeys(r.items)))
      .catch(() => setCommunities([]));
    return () => ctl.abort();
  }, []);
  const colorById = new Map(communities.map((c) => [c.id, c.color]));
  const communityColor = communities.length > 0 ? (id: number) => colorById.get(id) ?? "var(--color-community-none, #b5bdc7)" : undefined;

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError(null);
    listBridgeAuthors(q || undefined, minCommunities, offset, PAGE_SIZE, ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [q, minCommunities, offset]);

  const patch = (mutate: (p: URLSearchParams) => void, keepOffset = false) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      if (!keepOffset) next.delete("offset");
      return next;
    });

  const setSelected = (ref: EntityRef | undefined) => patch((p) => setRef(p, "author", "authorName", ref), true);
  const setMinCommunities = (n: number) => patch((p) => setNum(p, "min_communities", n === MIN_COMMUNITIES_DEFAULT ? undefined : n));

  const submitMin = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const n = Number(minDraft);
    if (isValidMinCommunities(n)) setMinCommunities(n);
  };

  const scoped = q !== "";
  const items = data?.items ?? [];
  const notComputed = data !== null && isNotComputed(data.total, data.algorithm);

  const columns: Column<BridgeAuthor>[] = [
    { key: "rank", label: "#", align: "right", render: (a) => offset + items.indexOf(a) + 1 },
    {
      key: "researcher",
      label: "Researcher",
      render: (a) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <EntityLink kind="author" id={a.author_id}>
            {a.full_name}
          </EntityLink>
        </span>
      ),
    },
    { key: "papers", label: "Papers", align: "right", render: (a) => formatCount(a.paper_count) },
    { key: "bridge", label: "Bridge score", render: (a) => <ScoreCell value={a.bridge_score} /> },
    {
      key: "main",
      label: "Most ties go to",
      render: (a) => {
        const top = mainTie(a);
        if (!top) return <span className="text-muted">&mdash;</span>;
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 shrink-0" style={{ backgroundColor: communityColor?.(top.community_id) ?? "var(--color-community-none, #b5bdc7)" }} aria-hidden="true" />
            <span>{top.label ?? "a replaced community"}</span>
            <span className="tabular-nums text-muted">&middot; {Math.round(top.share * 100)}%</span>
          </span>
        );
      },
    },
    { key: "betweenness", label: "Betweenness", align: "right", render: (a) => <span className="tabular-nums text-muted">{a.betweenness_centrality.toFixed(3)}</span> },
    { key: "touched", label: "Communities touched", align: "right", render: (a) => formatCount(a.communities_touched) },
    ...(scoped
      ? ([{ key: "matched", label: "Matched communities", align: "right", render: (a) => formatCount(a.matched_communities ?? 0) } as Column<BridgeAuthor>])
      : []),
  ];

  // Communities that appear in this page's ties, in legend order (plus any
  // replaced ones the legend no longer lists), for the table view and CSV.
  const shown = [
    ...communities.filter((c) => items.some((a) => a.ties.some((t) => t.community_id === c.id))),
    ...[...new Map(items.flatMap((a) => a.ties).filter((t) => !colorById.has(t.community_id)).map((t) => [t.community_id, t])).values()].map((t) => ({
      id: t.community_id,
      label: t.label ?? `Community ${t.community_id}`,
      color: "var(--color-community-none, #b5bdc7)",
    })),
  ];
  const shareOf = (a: BridgeAuthor, id: number) => a.ties.find((t) => t.community_id === id)?.share ?? 0;

  const csv = {
    filename: `${slug(q || "bridge-researchers")}-tie-profile.csv`,
    headers: ["author", "bridge_score", "betweenness_centrality", ...shown.map((c) => `share_${c.label}`)],
    rows: items.map((a) => [a.full_name, a.bridge_score, a.betweenness_centrality, ...shown.map((c) => shareOf(a, c.id))]),
  };

  const profileTableColumns: Column<BridgeAuthor>[] = [
    { key: "researcher", label: "Researcher", render: (a) => a.full_name },
    ...shown.map((c) => ({ key: `c${c.id}`, label: c.label, align: "right" as const, render: (a: BridgeAuthor) => `${Math.round(shareOf(a, c.id) * 100)}%` })),
    { key: "bridge", label: "Bridge score", align: "right", render: (a) => formatScore(a.bridge_score) },
  ];

  return (
    <div className="lg:flex lg:items-start lg:gap-6">
      <div className="min-w-0 flex-1 pb-16">
        <h1 className="font-serif text-[28px] font-semibold leading-tight">Bridge researchers</h1>
        <p className="mt-2 max-w-[68ch] text-base text-muted">
          {scoped
            ? `Researchers who publish across at least ${minCommunities} of the communities matching \u201c${q}\u201d, ranked by how many of those communities they bridge, then by bridge score.`
            : `Every researcher touching at least ${minCommunities} of the currently detected communities, ranked by bridge score.`}
        </p>

        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={submitMin}>
          <label className="flex flex-col text-sm">
            Minimum communities bridged
            <input
              type="number"
              min={MIN_COMMUNITIES_RANGE.min}
              max={MIN_COMMUNITIES_RANGE.max}
              inputMode="numeric"
              value={minDraft}
              onChange={(e) => setMinDraft(e.target.value)}
              className="mt-1 w-24 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5"
            />
          </label>
          <button type="submit" className="rounded-sm bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-ink">
            Apply
          </button>
          {minCommunities !== MIN_COMMUNITIES_DEFAULT && (
            <button
              type="button"
              onClick={() => setMinCommunities(MIN_COMMUNITIES_DEFAULT)}
              className="rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-accent-soft"
            >
              Reset to {MIN_COMMUNITIES_DEFAULT}
            </button>
          )}
        </form>

        {data?.search_meta && (data.search_meta as { truncated?: boolean }).truncated && (
          <NoticeBar kind="info">The search behind this topic scope hit its candidate limit; results may be incomplete.</NoticeBar>
        )}
        {data?.search_meta && (data.search_meta as { mongo?: string }).mongo === "unavailable" && (
          <NoticeBar kind="degraded">Abstract search is unavailable (MongoDB is down); results are from titles and topics only.</NoticeBar>
        )}

        {error && (
          <p role="alert" className="mt-5 text-sm text-warn">
            {error.kind === "network"
              ? `${error.message}. Start the stack with docker compose up -d, then reload.`
              : error.status === 422
                ? `The API only accepts a minimum-communities value from ${MIN_COMMUNITIES_RANGE.min} to ${MIN_COMMUNITIES_RANGE.max}. Choose a value in that range.`
                : `Could not load bridge researchers (${error.message}).`}
          </p>
        )}

        {!data && !error && (
          <div aria-busy="true" className="mt-5 border border-rule">
            <p className="sr-only">Loading bridge researchers</p>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-[34px] border-b border-rule bg-rule/30 last:border-b-0" />
            ))}
          </div>
        )}

        {data && data.total === 0 && (
          <div className="mt-5">
            {notComputed ? (
              <NotComputed analysis="Bridge researchers" command="python -m graph.influence" prerequisite="python -m graph.communities" />
            ) : scoped ? (
              <p className="max-w-xl text-sm">
                No researcher who publishes on &ldquo;{q}&rdquo; bridges at least {minCommunities} of its detected communities.{" "}
                <button type="button" onClick={() => patch((p) => p.delete("q"))} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                  Show every researcher
                </button>
                .
              </p>
            ) : (
              <p className="max-w-xl text-sm">
                No researcher touches at least {minCommunities} communities.{" "}
                <button type="button" onClick={() => setMinCommunities(1)} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                  Try a minimum of 1
                </button>
                .
              </p>
            )}
          </div>
        )}

        {data && data.total > 0 && (
          <div className="mt-5 space-y-6">

            <div>
              <p className="mb-2 max-w-[68ch] text-sm text-muted">
                A bridge researcher&rsquo;s ties are spread across communities. The lower the share going to their main community, the more evenly they connect the others.
              </p>
              <DataTable
                columns={columns}
                rows={items}
                rowKey={(a) => a.author_id}
                caption={scoped ? `Researchers bridging communities matching "${q}"` : "Researchers bridging detected communities"}
                onRowActivate={(a) => setSelected({ id: a.author_id, name: a.full_name })}
              />
              <Pagination offset={offset} limit={PAGE_SIZE} total={data.total} onPage={(o) => patch((p) => setNum(p, "offset", o || undefined), true)} />
            </div>

            <div>
              <button
                type="button"
                aria-expanded={showProfiles}
                onClick={() => setShowProfiles((v) => !v)}
                className="rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-accent-soft"
              >
                {showProfiles ? "Hide tie profiles" : "Compare tie profiles"}
              </button>
              {showProfiles && (
                <div className="mt-3">
                <Figure
                  title="Where each researcher's ties go"
                  subtitle="Each bar splits a researcher's collaboration ties by community. An even split across many communities is what a high bridge score means; one dominant colour means a researcher mostly works inside one community."
                  caption={`${formatCount(data.total)} researcher${data.total === 1 ? "" : "s"} ${scoped ? `bridging communities matching \u201c${q}\u201d` : "bridging detected communities"}, min ${minCommunities}. Showing ranks ${offset + 1} to ${offset + items.length}, in the table's order.`}
                  svg={<TieProfileChart authors={items} communities={communities} rankFrom={offset + 1} onSelect={(a) => setSelected({ id: a.author_id, name: a.full_name })} />}
                  tableView={<DataTable columns={profileTableColumns} rows={items} rowKey={(a) => a.author_id} caption="Share of each researcher's ties per community" />}
                  csv={csv}
                  method={{
                    algorithm: data.algorithm ?? null,
                    explanation:
                      "A tie's weight combines co-authorship, citation, shared-topic and institutional links. Each bar is the share of that weight going into each community Louvain detected. Bridge score is the participation coefficient, 1 minus the sum of squared shares: 0 when every tie is in one community, approaching 1 - 1/k for an even split across k communities.",
                  }}
                />
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      <Drawer open={selected !== undefined} onClose={() => setSelected(undefined)} title={selected ? `${selected.name}, bridge evidence` : "Researcher details"}>
        {selected && (
          <article>
            <h2 className="font-serif text-xl font-semibold leading-snug">{selected.name}</h2>
            <p className="mt-1 text-sm">
              <Link to={`/authors/${selected.id}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                Open full page
              </Link>
            </p>
            <div className="mt-4">
              <InfluencePanel authorId={selected.id} communityColor={communityColor} />
            </div>
          </article>
        )}
      </Drawer>
    </div>
  );
}
