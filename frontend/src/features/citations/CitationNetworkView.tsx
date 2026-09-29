import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import EntityLink from "../../components/EntityLink";
import NoticeBar from "../../components/NoticeBar";
import NotComputed from "../../components/NotComputed";
import GraphCanvas from "../../graph/GraphCanvas";
import LegendList from "../../graph/Legend";
import { ApiError } from "../../api/client";
import { citationChain } from "../../api/papers";
import { searchCitationNetwork, type CitationNetwork, type CitationNetworkNode, type SearchFilters } from "../../api/search";
import { formatCount } from "../../lib/format";
import { buildCategoricalLegend, matchesCategory, nodeRadius, rankedOrder, type IsolationKey } from "../../lib/graph";
import { getNum, getRef, getStr } from "../../lib/urlState";
import PaperPeek from "../explore/PaperPeek";

const MAX_NODES = 400;
const CHAIN_DEPTH = 6;

function readFilters(params: URLSearchParams): SearchFilters {
  return {
    q: getStr(params, "q") ?? "",
    yearFrom: getNum(params, "from"),
    yearTo: getNum(params, "to"),
    author: getRef(params, "author", "authorName"),
    institution: getRef(params, "inst", "instName"),
    venue: getRef(params, "venue", "venueName"),
  };
}

type ColorMode = "year" | "community";

/** /explore/network (G2): the citation network of the current search scope
 * -- the same result set /explore's paper list shows, filtered the same
 * way. Directed citing -> cited edges; node size by citation count; color
 * by publication year or by the paper's authors' majority community.
 * Selecting a paper opens its drawer (features/explore/PaperPeek, the same
 * one Explore uses) and highlights its citation chain in the graph, reusing
 * /papers/{id}/citation-chain rather than a second lookup. The graph itself
 * is the shared engine from Phase 4 (graph/GraphCanvas, graph/forceLayout,
 * lib/graph) with citation-specific accessors -- see those files' doc
 * comments for what's shared versus per-graph-type. */
export default function CitationNetworkView() {
  const [params] = useSearchParams();
  const f = readFilters(params);
  const filterKey = JSON.stringify(f);

  const [graph, setGraph] = useState<CitationNetwork | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("year");
  const [isolated, setIsolated] = useState<IsolationKey>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [asList, setAsList] = useState(false);
  const [chainIds, setChainIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const ctl = new AbortController();
    setGraph(null);
    setError(null);
    setIsolated(null);
    setSelected(null);
    searchCitationNetwork(f, MAX_NODES, ctl.signal)
      .then(setGraph)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // Chain highlighting: reuses /papers/{id}/citation-chain in both
  // directions rather than deriving ancestry from the edges already on
  // screen, so it reflects the paper's real citation chain even past
  // whatever max_nodes cut off the drawn graph.
  useEffect(() => {
    if (selected === null) {
      setChainIds(new Set());
      return;
    }
    const ctl = new AbortController();
    Promise.all([citationChain(selected, "cites", CHAIN_DEPTH, ctl.signal), citationChain(selected, "cited_by", CHAIN_DEPTH, ctl.signal)])
      .then(([ancestors, descendants]) => {
        setChainIds(new Set([selected, ...ancestors.map((n) => n.paper_id), ...descendants.map((n) => n.paper_id)]));
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setChainIds(new Set([selected]));
      });
    return () => ctl.abort();
  }, [selected]);

  const nodes = graph?.nodes ?? [];
  const edges = useMemo(() => edgesForEngine(graph?.edges ?? []), [graph]);
  const maxCitations = Math.max(1, ...nodes.map((n) => n.citation_count));
  const years = useMemo(() => [...new Set(nodes.map((n) => n.year))].sort((a, b) => b - a), [nodes]);

  const { legend, colorOf } = useMemo(() => {
    if (colorMode === "community") {
      return buildCategoricalLegend(
        nodes,
        (n) => n.community_id,
        (id) => `Community ${id}`,
        { noneLabel: "Not yet assigned", otherLabel: "Other communities" },
      );
    }
    return buildCategoricalLegend(nodes, (n) => n.year, (y) => String(y), { noneLabel: "Unknown year" });
  }, [nodes, colorMode]);
  const categoryOf = colorMode === "community" ? (n: CitationNetworkNode) => n.community_id : (n: CitationNetworkNode) => n.year;

  const legendRank = useMemo(() => new Map(legend.filter((e) => !e.isOther && e.communityId !== null).map((e, i) => [e.communityId as number, i])), [legend]);
  const order = useMemo(() => rankedOrder(nodes, edges, (n) => n.paper_id, categoryOf, legendRank), [nodes, edges, legendRank, categoryOf]);

  const noCommunitiesYet = nodes.length > 0 && nodes.every((n) => n.community_id === null);
  const selectedNode = nodes.find((n) => n.paper_id === selected) ?? null;

  const columns: Column<CitationNetworkNode>[] = [
    { key: "title", label: "Paper", render: (n) => <EntityLink kind="paper" id={n.paper_id}>{n.title}</EntityLink> },
    { key: "year", label: "Year", align: "right", render: (n) => n.year },
    { key: "citations", label: "Citations", align: "right", render: (n) => formatCount(n.citation_count) },
    { key: "community", label: "Community", render: (n) => (n.community_id === null ? <span className="text-muted">Not yet assigned</span> : `Community ${n.community_id}`) },
  ];

  return (
    <div className="pb-16">
      <p className="text-sm">
        <Link to={f.q ? `/explore?q=${encodeURIComponent(f.q)}` : "/explore"} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          &larr; Explore
        </Link>
      </p>
      <h1 className="mt-2 font-serif text-[28px] font-semibold leading-tight">Citation network</h1>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        {f.q ? (
          <>Papers matching &ldquo;{f.q}&rdquo;, and how they cite one another. An arrow points from the citing paper to the paper it cites.</>
        ) : (
          <>Every paper with at least one citation link to another, corpus-wide. Set a topic scope above to narrow this to a smaller graph.</>
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
          <NotComputed analysis="A citation network for this scope" command="python -m ingestion.run_ingestion" />
          <p className="mt-2 max-w-xl text-sm text-muted">{f.q ? "No paper matching this topic cites, or is cited by, another paper in the result set." : "The corpus may be empty, or no two papers cite each other yet."}</p>
        </div>
      )}

      {graph && graph.nodes.length > 0 && (
        <div className="mt-5">
          {graph.truncated && (
            <NoticeBar kind="info">
              Showing the {formatCount(graph.nodes.length)} most-connected of {formatCount(graph.total_candidates)} papers. Narrow the topic scope above to see the rest.
            </NoticeBar>
          )}
          {graph.search_meta.mongo === "unavailable" && <NoticeBar kind="degraded">Abstract search is offline, so this scope comes from titles and topic tags only.</NoticeBar>}
          {colorMode === "community" && noCommunitiesYet && <NoticeBar kind="info">Communities have not been detected yet (run python -m graph.communities), so every paper is shown unassigned, grey.</NoticeBar>}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <LegendList entries={legend} isolated={isolated} onIsolate={setIsolated} />
              <label className="flex items-center gap-1.5 text-sm text-muted">
                Color by
                <select
                  value={colorMode}
                  onChange={(e) => {
                    setColorMode(e.target.value as ColorMode);
                    setIsolated(null);
                  }}
                  className="border border-rule-strong bg-sheet px-1.5 py-1"
                >
                  <option value="year">Year</option>
                  <option value="community">Community</option>
                </select>
              </label>
            </div>
            <button type="button" onClick={() => setAsList((v) => !v)} className="shrink-0 rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-accent-soft">
              {asList ? "View as graph" : "View as list"}
            </button>
          </div>
          {!asList && years.length > 1 && <p className="mt-1 text-xs text-muted">{years[years.length - 1]}&ndash;{years[0]}. Node size shows citation count.</p>}
          {!asList && selected !== null && <p className="mt-1 text-xs text-muted">Highlighting the citation chain for the selected paper (up to {CHAIN_DEPTH} steps each direction).</p>}

          <div className="mt-4">
            {asList ? (
              <DataTable columns={columns} rows={nodes} rowKey={(n) => n.paper_id} caption="Papers in this network" onRowActivate={(n) => setSelected(n.paper_id)} />
            ) : (
              <GraphCanvas
                nodes={nodes}
                edges={edges}
                idOf={(n) => n.paper_id}
                radiusOf={(n) => nodeRadius(n.citation_count, maxCitations)}
                colorOf={(n) => colorOf(categoryOf(n))}
                ariaLabelOf={(n) => `${n.title}, ${n.year}, ${n.citation_count} ${n.citation_count === 1 ? "citation" : "citations"}`}
                order={order}
                clusterOf={colorMode === "community" ? (n) => n.community_id : undefined}
                isDimmedByIsolation={isolated !== null ? (n) => !matchesCategory(n, isolated, categoryOf, colorOf) : undefined}
                isEmphasizedEdge={chainIds.size > 0 ? (e) => chainIds.has(e.source) && chainIds.has(e.target) : undefined}
                ringWidthOf={chainIds.size > 0 ? (n) => (chainIds.has(n.paper_id) ? 2.5 : 0) : undefined}
                directed
                selected={selected}
                onSelect={setSelected}
                hoverStatusOf={(n, ties) => `${n.title}: ${ties} direct ${ties === 1 ? "citation link" : "citation links"}`}
                idleStatus="Click a paper to open its details and highlight its citation chain. Hover to see direct links."
                ariaGraphLabel={(visible) => `Citation network: ${nodes.length} papers, ${visible} citation links shown`}
              />
            )}
          </div>
        </div>
      )}

      <PaperPeek paperId={selectedNode ? selectedNode.paper_id : null} onClose={() => setSelected(null)} onKeyword={() => {}} />
    </div>
  );
}

/** CitationNetworkEdge's citing_id/cited_id, mapped to the shared engine's
 * generic source/target/weight shape (lib/graph.ts's GraphEdge) -- citation
 * edges carry no weight of their own, so every edge reads as weight 1. */
function edgesForEngine(edges: CitationNetwork["edges"]) {
  return edges.map((e) => ({ source: e.citing_id, target: e.cited_id }));
}
