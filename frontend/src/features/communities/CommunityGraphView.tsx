import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import EntityLink from "../../components/EntityLink";
import NoticeBar from "../../components/NoticeBar";
import NotComputed from "../../components/NotComputed";
import AdjacencyMatrix from "../../charts/AdjacencyMatrix";
import CommunityMap from "../../charts/CommunityMap";
import Figure from "../../components/Figure";
import { membersByCohesion, summarizeCommunities, takeaway } from "../../lib/communityMap";
import LegendList from "../../graph/Legend";
import { ApiError } from "../../api/client";
import { communityGraph, listCommunities, type CommunityGraph, type CommunityGraphNode } from "../../api/communities";
import { formatCount, formatDate, formatScore } from "../../lib/format";
import { buildLegend, matchesIsolation, tabOrder, type IsolationKey } from "../../lib/graph";
import { getStr } from "../../lib/urlState";
import AuthorPeek from "./AuthorPeek";

const MAX_NODES = 400;

/** /communities/graph (G1): the same scope-aware ?q= as /communities and
 * Explore, the same underlying data as the RESEARCH_COMMUNITY/COMMUNITY_
 * MEMBER tables the index page reads — this never computes its own
 * partition, only draws the one /communities/graph reports. The top bar
 * (ScopeContext) owns writing ?q= for this page; this component only reads
 * it. */
export default function CommunityGraphView() {
  const [params] = useSearchParams();
  const q = getStr(params, "q") ?? "";

  const [graph, setGraph] = useState<CommunityGraph | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [labelById, setLabelById] = useState<Map<number, string>>(new Map());
  const [minTieStrength, setMinTieStrength] = useState(0);
  const [isolated, setIsolated] = useState<IsolationKey>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // "map" (the community overview) leads; the researcher-level matrix and
  // the plain list are one click away.
  const [view, setView] = useState<"map" | "matrix" | "list">("map");
  const [selectedCommunity, setSelectedCommunity] = useState<number | null>(null);
  const [showBridgeRings, setShowBridgeRings] = useState(true);

  useEffect(() => {
    const ctl = new AbortController();
    setGraph(null);
    setError(null);
    setMinTieStrength(0);
    setIsolated(null);
    setSelected(null);
    setSelectedCommunity(null);
    communityGraph(q || undefined, 0, MAX_NODES, ctl.signal)
      .then(setGraph)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [q]);

  // Community labels aren't on the graph nodes (only community_id) — one
  // extra request for the legend and the drawer to name communities by
  // label rather than a bare ID.
  useEffect(() => {
    const ctl = new AbortController();
    // 100 is the API's page cap (a larger limit is a 422, which left every
    // legend entry as "Community N" until the Phase 9 browser pass caught
    // it). A run keeps far fewer communities than that; any past the first
    // 100 still fall back to their id.
    listCommunities(q || undefined, 0, 0, 100, ctl.signal)
      .then((r) => setLabelById(new Map(r.items.map((c) => [c.community_id, c.label ?? `Community ${c.community_id}`]))))
      .catch(() => setLabelById(new Map()));
    return () => ctl.abort();
  }, [q]);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const { legend, colorOf } = useMemo(() => buildLegend(nodes, labelById), [nodes, labelById]);
  const legendRank = useMemo(() => new Map(legend.filter((e) => !e.isOther && e.communityId !== null).map((e, i) => [e.communityId as number, i])), [legend]);
  const maxWeight = Math.max(0, ...edges.map((e) => e.weight));
  const order = useMemo(() => tabOrder(nodes, edges, legendRank), [nodes, edges, legendRank]);
  const selectedNode = nodes.find((n) => n.author_id === selected) ?? null;
  const summary = useMemo(() => summarizeCommunities(nodes, edges), [nodes, edges]);
  const hasCommunities = summary.communities.length > 0;
  const communityLabel = (id: number) => labelById.get(id) ?? `Community ${id}`;
  const showMap = hasCommunities && view === "map";
  const asList = view === "list";
  const openCommunity = selectedCommunity !== null ? summary.communities.find((c) => c.id === selectedCommunity) ?? null : null;
  const openMembers = useMemo(() => (selectedCommunity === null ? [] : membersByCohesion(selectedCommunity, nodes, edges)), [selectedCommunity, nodes, edges]);
  const openLinks = openCommunity ? summary.links.filter((l) => l.a === openCommunity.id || l.b === openCommunity.id) : [];
  const viewButton = "rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-accent-soft";

  const columns: Column<CommunityGraphNode>[] = [
    { key: "name", label: "Researcher", render: (n) => <EntityLink kind="author" id={n.author_id}>{n.full_name}</EntityLink> },
    {
      key: "community",
      label: "Community",
      render: (n) => (n.community_id === null ? <span className="text-muted">Unassigned</span> : (labelById.get(n.community_id) ?? `Community ${n.community_id}`)),
    },
    { key: "papers", label: "Papers", align: "right", render: (n) => formatCount(n.paper_count) },
    { key: "bridge", label: "Bridge score", align: "right", render: (n) => formatScore(n.bridge_score) },
    { key: "touched", label: "Communities touched", align: "right", render: (n) => (n.communities_touched === null ? <span className="text-muted">&mdash;</span> : formatCount(n.communities_touched)) },
  ];

  return (
    <div className="pb-16">
      <p className="text-sm">
        <Link to={q ? `/communities?q=${encodeURIComponent(q)}` : "/communities"} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          &larr; Communities
        </Link>
      </p>
      <h1 className="mt-2 font-serif text-[28px] font-semibold leading-tight">Collaboration graph</h1>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        {q ? (
          <>Researchers who wrote a paper matching &ldquo;{q}&rdquo;, and their co-authorship, citation, shared-topic and institutional ties.</>
        ) : (
          <>Every researcher with at least one qualifying tie, corpus-wide. Search a topic above to scope this to a smaller graph.</>
        )}
      </p>

      {error && (
        <p role="alert" className="mt-5 text-sm text-warn">
          {error.kind === "network" ? `${error.message}. Start the stack with docker compose up -d, then reload.` : `Could not load the graph (${error.message}).`}
        </p>
      )}

      {!graph && !error && <p className="mt-5 text-sm text-muted">Loading graph&hellip;</p>}

      {graph && graph.nodes.length === 0 && (
        <div className="mt-5">
          <NotComputed analysis="The collaboration graph" command="python -m ingestion.derive_collaboration" />
          <p className="mt-2 max-w-xl text-sm text-muted">
            {q ? "No researcher matching this topic has a co-authorship, citation, shared-topic or institutional tie to another." : "The corpus may be empty, or no two researchers share any of the four tie types yet."}
          </p>
        </div>
      )}

      {graph && graph.nodes.length > 0 && (
        <div className="mt-5">
          {graph.truncated && (
            <NoticeBar kind="info">
              Showing the {formatCount(graph.nodes.length)} most-connected of {formatCount(graph.total_candidates)} researchers. Narrow the topic scope above to see the rest.
            </NoticeBar>
          )}
          {graph.algorithm === null && <NoticeBar kind="info">Communities have not been detected yet (run python -m graph.communities), so every node is shown unassigned, grey.</NoticeBar>}
          {graph.algorithm !== null && (
            <p className="mb-3 text-xs text-muted">
              Communities detected {formatDate(graph.detection_date)} &middot; <code className="font-mono text-[11px]">{graph.algorithm}</code>
            </p>
          )}

          {showMap ? (
            <>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setView("matrix")} className={viewButton}>
              Show researcher-level matrix
            </button>
            <button type="button" onClick={() => setView("list")} className={viewButton}>
              View as list
            </button>
          </div>
          {takeaway(summary, communityLabel).length > 0 && <p className="mt-4 max-w-[68ch] font-serif text-[17px] leading-relaxed">{takeaway(summary, communityLabel).join(" ")}</p>}
          {summary.unassigned > 0 && (
            <p className="mt-1 text-xs text-muted">
              {formatCount(summary.unassigned)} researcher{summary.unassigned === 1 ? " is" : "s are"} in no community and not on the map; the list and matrix include them.
            </p>
          )}
          <div className="mt-4">
            <Figure
              title="Communities and the ties between them"
              subtitle="Node area is the number of members. A link's value and weight give the average tie strength between a member of one community and a member of the other."
              caption={`${formatCount(summary.communities.length)} communities of ${formatCount(nodes.length - summary.unassigned)} researchers${q ? ` who wrote papers matching “${q}”` : ", corpus-wide"}. Tie strength combines co-authorship, citation, shared-topic and institutional links, averaged per pair of researchers.`}
              svg={<CommunityMap summary={summary} labelOf={communityLabel} colorOf={(id) => colorOf(id)} selectedId={selectedCommunity} onSelect={setSelectedCommunity} />}
              tableView={
                <DataTable
                  columns={[
                    { key: "community", label: "Community", render: (c: (typeof summary.communities)[number]) => communityLabel(c.id) },
                    { key: "members", label: "Members", align: "right", render: (c: (typeof summary.communities)[number]) => formatCount(c.size) },
                    { key: "within", label: "Internal tie", align: "right", render: (c: (typeof summary.communities)[number]) => c.within.toFixed(1) },
                    ...summary.communities.map((o) => ({
                      key: `c${o.id}`,
                      label: `Tie with ${communityLabel(o.id)}`,
                      align: "right" as const,
                      render: (c: (typeof summary.communities)[number]) =>
                        c.id === o.id ? "—" : (summary.links.find((l) => (l.a === c.id && l.b === o.id) || (l.a === o.id && l.b === c.id))?.avg.toFixed(1) ?? "0.0"),
                    })),
                  ]}
                  rows={summary.communities}
                  rowKey={(c) => c.id}
                  caption="Average tie strength within and between communities"
                />
              }
              csv={{
                filename: `community-ties${q ? `-${q.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : ""}.csv`,
                headers: ["community_a", "community_b", "average_tie"],
                rows: [
                  ...summary.communities.map((c) => [communityLabel(c.id), communityLabel(c.id), Number(c.within.toFixed(4))]),
                  ...summary.links.map((l) => [communityLabel(l.a), communityLabel(l.b), Number(l.avg.toFixed(4))]),
                ],
              }}
              method={{
                algorithm: graph.algorithm ?? null,
                detectionDate: graph.detection_date,
                explanation:
                  "Communities are the Louvain partition of the weighted author collaboration graph. Internal tie is the sum of tie weights between members of one community divided by the number of member pairs; a link's value is the sum between two communities divided by the product of their sizes, so larger communities do not score higher just by being larger.",
              }}
            />
          </div>

          {openCommunity && (
            <section className="mt-4 border border-rule-strong bg-sheet px-4 py-3" aria-label="Selected community">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-serif text-lg font-semibold leading-snug">
                  <Link to={`/communities/${openCommunity.id}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                    {communityLabel(openCommunity.id)}
                  </Link>
                </h2>
                <button type="button" onClick={() => setSelectedCommunity(null)} className="shrink-0 text-sm text-muted underline hover:text-ink">
                  Close
                </button>
              </div>
              <p className="mt-1 text-sm text-muted">
                {formatCount(openCommunity.size)} members, internal tie {openCommunity.within.toFixed(1)} (average between two members)
              </p>
              {openLinks.length > 0 && (
                <>
                  <h3 className="mt-3 text-sm font-semibold">Links to other communities</h3>
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {openLinks.map((l) => {
                      const other = l.a === openCommunity.id ? l.b : l.a;
                      return (
                        <li key={other} className="flex items-center gap-2">
                          <span className="inline-block h-2.5 w-2.5 shrink-0" style={{ backgroundColor: colorOf(other) }} aria-hidden="true" />
                          <span>{communityLabel(other)}</span>
                          <span className="ml-auto tabular-nums text-muted">average tie {l.avg.toFixed(1)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              <h3 className="mt-3 text-sm font-semibold">Members, most tied-in first</h3>
              <div className="mt-1">
                <DataTable
                  columns={[
                    { key: "name", label: "Researcher", render: (m: (typeof openMembers)[number]) => <EntityLink kind="author" id={m.node.author_id}>{m.node.full_name}</EntityLink> },
                    { key: "inside", label: "Ties inside the community", align: "right", render: (m: (typeof openMembers)[number]) => <span className="tabular-nums">{m.inside.toFixed(1)}</span> },
                    { key: "bridge", label: "Bridge score", align: "right", render: (m: (typeof openMembers)[number]) => formatScore(m.node.bridge_score) },
                  ]}
                  rows={openMembers}
                  rowKey={(m) => m.node.author_id}
                  caption={`Members of ${communityLabel(openCommunity.id)}`}
                  onRowActivate={(m) => setSelected(m.node.author_id)}
                />
              </div>
            </section>
          )}
            </>
          ) : (
            <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <LegendList entries={legend} isolated={isolated} onIsolate={setIsolated} />
            <div className="flex shrink-0 items-center gap-3">
              {!asList && (
                <label className="flex items-center gap-1.5 text-sm text-muted">
                  <input type="checkbox" checked={showBridgeRings} onChange={(e) => setShowBridgeRings(e.target.checked)} />
                  Bridge overlay
                </label>
              )}
              {hasCommunities && (
                <button type="button" onClick={() => setView("map")} className={viewButton}>
                  Back to community map
                </button>
              )}
              <button type="button" onClick={() => setView(asList ? "matrix" : "list")} className={viewButton}>
                {asList ? "View as matrix" : "View as list"}
              </button>
            </div>
          </div>
          {!asList && showBridgeRings && (
            <p className="mt-1 text-xs text-muted">The bar beside each name shows bridge score &mdash; how evenly a researcher&rsquo;s ties spread across communities.</p>
          )}

          {!asList && maxWeight > 0 && (
            <div className="mt-3 flex items-center gap-3 text-sm">
              <label htmlFor="tie-strength" className="shrink-0 text-muted">
                Minimum tie strength
              </label>
              <input
                id="tie-strength"
                type="range"
                min={0}
                max={maxWeight}
                step={maxWeight / 100}
                value={minTieStrength}
                onChange={(e) => setMinTieStrength(Number(e.target.value))}
                className="w-48"
              />
              <span className="tabular-nums text-muted">{minTieStrength.toFixed(2)}</span>
            </div>
          )}

          <div className="mt-4">
            {asList ? (
              <DataTable columns={columns} rows={nodes} rowKey={(n) => n.author_id} caption="Researchers in this graph" onRowActivate={(n) => setSelected(n.author_id)} />
            ) : (
              <>
                <p className="mb-1 text-xs text-muted">
                  Each cell is one pair of researchers; darker blue means a stronger tie. Researchers are grouped by community, and each community&rsquo;s block is outlined along the diagonal, so dark cells outside a block are ties between communities.
                </p>
                <AdjacencyMatrix
                  nodes={order.map((n) => ({
                    id: n.author_id,
                    label: n.full_name,
                    color: colorOf(n.community_id),
                    group: n.community_id,
                    dimmed: isolated !== null && !matchesIsolation(n, isolated, colorOf),
                    marker: showBridgeRings ? n.bridge_score : null,
                  }))}
                  edges={edges}
                  weightName="tie strength"
                  formatWeight={(w) => w.toFixed(1)}
                  blocks
                  minWeight={minTieStrength}
                  selectedId={selected}
                  onSelect={setSelected}
                  markerName="bridge score"
                  ariaLabel={`Collaboration matrix: ${nodes.length} researchers grouped by community`}
                  idleStatus="Hover a cell for the pair's tie strength. Click a researcher to open their details."
                />
              </>
            )}
          </div>
            </>
          )}
        </div>
      )}

      <AuthorPeek node={selectedNode} communityLabel={selectedNode?.community_id != null ? (labelById.get(selectedNode.community_id) ?? null) : null} onClose={() => setSelected(null)} />
    </div>
  );
}
