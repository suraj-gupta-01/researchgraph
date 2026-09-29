import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import Drawer from "../../components/Drawer";
import EntityLink from "../../components/EntityLink";
import Method from "../../components/Method";
import NotComputed from "../../components/NotComputed";
import Pagination from "../../components/Pagination";
import Sparkline from "../../components/Sparkline";
import TrendBadge from "../../components/TrendBadge";
import { ApiError, type Page } from "../../api/client";
import { metaRuns } from "../../api/meta";
import { convergingTopics, type ConvergingTopicPair } from "../../api/topics";
import { formatCount } from "../../lib/format";
import { formatGrowth, isNewGrowth } from "../../lib/trend";
import {
  CONVERGENCE_ALGORITHM_NOTE,
  CONVERGENCE_LIMITATION,
  convergenceRun,
  filterPairsByTopic,
  type ConvergenceRun,
  isNotComputed,
  mostFrequentTopic,
  pairKey,
  pairSparkPoints,
  rampColor,
  scoreShade,
} from "../../lib/convergence";
import { getNum, getRef, setNum, setRef } from "../../lib/urlState";
import PairMatrixFigure from "./PairMatrixFigure";
import PairTrendPanel from "./PairTrendPanel";

const PAGE_SIZE = 25;

function ConvergenceScoreCell({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? value / max : 0; // bar length: linear, so it encodes the magnitude
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-14 bg-rule" aria-hidden="true">
        <span className="block h-full" style={{ width: `${Math.min(100, pct * 100)}%`, backgroundColor: rampColor(scoreShade(value, max)) }} />
      </span>
      <span className="tabular-nums text-muted">{value.toFixed(2)}</span>
    </span>
  );
}

/** /connections: F5's acceptance view -- "a ranked list of converging topic
 * pairs ... with a trend indicator, each pair traceable to its counts"
 * (references/phases.md Phase 6). Consumes GET /topics/converging, which
 * takes only `year` (no topic-scope `q`) -- corpus-wide, like Trends.
 * Row activation opens the pair's full co-occurrence trajectory (Phase 6b,
 * GET /topics/pairs/{a}/{b}/trend, gap G3); this board's own 2-point
 * sparkline needs no such request.
 *
 * Phase 6c adds the adjacency-matrix overview, a client-side "hide the
 * most frequent topic" filter, and the board's Method. The filter only
 * removes rows from the page already loaded -- it never re-queries and never
 * re-ranks, so ranks keep the server's numbering (gaps mark hidden pairs)
 * and the pagination total stays the server's. The hidden topic is pinned in
 * the URL (`hideTopic`) so a shared link reproduces the view and paging does
 * not silently swap which topic is hidden. */
export default function ConnectionsBoard() {
  const [params, setParams] = useSearchParams();
  const year = getNum(params, "year");
  const offset = getNum(params, "offset") ?? 0;
  const pairA = getRef(params, "pairA", "pairAName");
  const pairB = getRef(params, "pairB", "pairBName");
  const hidden = getRef(params, "hideTopic", "hideTopicName");

  const [data, setData] = useState<Page<ConvergingTopicPair> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [yearDraft, setYearDraft] = useState("");

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError(null);
    convergingTopics(year, offset, PAGE_SIZE, ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [year, offset]);

  // The list carries no algorithm string, so Method reads the run's from
  // /meta/runs; if that fails, CONVERGENCE_ALGORITHM_NOTE stands in.
  const [run, setRun] = useState<ConvergenceRun | undefined>(undefined);
  useEffect(() => {
    const ctl = new AbortController();
    metaRuns(ctl.signal)
      .then((m) => setRun(convergenceRun(m.runs)))
      .catch(() => setRun(undefined));
    return () => ctl.abort();
  }, []);

  const resolvedYear = year ?? data?.items[0]?.year;
  useEffect(() => setYearDraft(resolvedYear === undefined ? "" : String(resolvedYear)), [resolvedYear]);

  const patch = (mutate: (p: URLSearchParams) => void, keepOffset = false) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      if (!keepOffset) next.delete("offset");
      return next;
    });
  const setYear = (y: number | undefined) => patch((p) => setNum(p, "year", y));
  const selectPair = (pair: ConvergingTopicPair) =>
    patch((p) => {
      setRef(p, "pairA", "pairAName", { id: pair.topic_a_id, name: pair.topic_a_name });
      setRef(p, "pairB", "pairBName", { id: pair.topic_b_id, name: pair.topic_b_name });
    }, true);
  const clearPair = () =>
    patch((p) => {
      setRef(p, "pairA", "pairAName", undefined);
      setRef(p, "pairB", "pairBName", undefined);
    }, true);

  const toggleHide = (topic: { id: number; name: string } | null) =>
    patch((p) => setRef(p, "hideTopic", "hideTopicName", hidden ? undefined : (topic ?? undefined)), true);

  const submitYear = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const n = Number(yearDraft);
    if (Number.isInteger(n) && n >= 1 && n <= 2100) setYear(n);
  };

  const items = data?.items ?? [];
  const y = resolvedYear;
  // Shading is normalized against the whole page, hidden rows included, so
  // toggling the filter never changes how a remaining row is colored.
  const maxScore = Math.max(0, ...items.map((p) => p.convergence_score));
  const notComputed = data !== null && isNotComputed(data.total, year);
  const dominant = mostFrequentTopic(items);
  const visible = filterPairsByTopic(items, hidden?.id);
  const hiddenCount = items.length - visible.length;
  // Ranks are the server's, not the visible index: hiding a row leaves a gap.
  const rankOf = new Map(items.map((p, i) => [pairKey(p), offset + i + 1]));

  const columns: Column<ConvergingTopicPair>[] = [
    { key: "rank", label: "#", align: "right", render: (p) => rankOf.get(pairKey(p)) },
    {
      key: "pair",
      label: "Topic pair",
      render: (p) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <EntityLink kind="topic" id={p.topic_a_id}>
            {p.topic_a_name}
          </EntityLink>
          <span aria-hidden="true" className="text-faint">
            +
          </span>
          <EntityLink kind="topic" id={p.topic_b_id}>
            {p.topic_b_name}
          </EntityLink>
        </span>
      ),
    },
    { key: "now", label: y === undefined ? "Shared papers this year" : `Shared papers in ${y}`, align: "right", render: (p) => formatCount(p.cooccurrence_count) },
    {
      key: "prior",
      label: y === undefined ? "Shared papers the year before" : `Shared papers in ${y - 1}`,
      align: "right",
      render: (p) => (p.prior_cooccurrence_count > 0 ? formatCount(p.prior_cooccurrence_count) : <span className="text-muted">none</span>),
    },
    { key: "growth", label: "Growth", align: "right", render: (p) => formatGrowth(p.growth_rate, p.prior_cooccurrence_count) },
    { key: "score", label: "Convergence score", render: (p) => <ConvergenceScoreCell value={p.convergence_score} max={maxScore} /> },
    { key: "trend", label: "Trend", render: (p) => <TrendBadge label="Converging" isNew={isNewGrowth(p.growth_rate, p.prior_cooccurrence_count)} /> },
    { key: "spark", label: "Co-occurrence, year before to this year", render: (p) => <Sparkline points={pairSparkPoints(p)} /> },
  ];

  return (
    <div className="lg:flex lg:items-start lg:gap-6">
      <div className="min-w-0 flex-1 pb-16">
        <h1 className="font-serif text-[28px] font-semibold leading-tight">Interdisciplinary connections</h1>
        <p className="mt-2 max-w-[68ch] text-base text-muted">
          Topic pairs whose shared-paper count grew fast enough to classify as converging
          {y === undefined ? "" : `, for ${y}${year === undefined ? " (the latest period with any converging pairs)" : ""}`}. The board covers the whole corpus; the topic scope in the top bar does not filter it.
        </p>

        <div className="max-w-[72ch]">
          <Method
            algorithm={run?.algorithm ?? null}
            algorithmNote={CONVERGENCE_ALGORITHM_NOTE}
            detectionDate={run?.detectedAt}
            explanation={`Shared papers are papers tagged with both topics. The convergence score is the pair's year-over-year growth in shared papers, and a pair is marked converging when it clears a minimum shared-paper count and a minimum growth rate in that year; ${run ? "those thresholds are the run's parameters, shown in the algorithm string above" : "those thresholds are part of the run's parameters, which this list does not report"}. ${CONVERGENCE_LIMITATION}`}
          />
        </div>

        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={submitYear}>
          <label className="flex flex-col text-sm">
            Year
            <input
              type="number"
              min={1}
              max={2100}
              inputMode="numeric"
              value={yearDraft}
              onChange={(e) => setYearDraft(e.target.value)}
              className="mt-1 w-24 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5"
            />
          </label>
          <button type="submit" className="rounded-sm bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-ink">
            Show year
          </button>
          <button
            type="button"
            disabled={y === undefined}
            onClick={() => y !== undefined && setYear(y - 1)}
            className="rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm enabled:hover:bg-accent-soft disabled:text-faint"
          >
            Previous year
          </button>
          <button
            type="button"
            disabled={y === undefined}
            onClick={() => y !== undefined && setYear(y + 1)}
            className="rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm enabled:hover:bg-accent-soft disabled:text-faint"
          >
            Next year
          </button>
          {year !== undefined && (
            <button type="button" onClick={() => setYear(undefined)} className="rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-accent-soft">
              Latest period
            </button>
          )}
        </form>

        {error && (
          <p role="alert" className="mt-5 text-sm text-warn">
            {error.kind === "network"
              ? `${error.message}. Start the stack with docker compose up -d, then reload.`
              : error.status === 422
                ? "The API only accepts years from 1 to 2100. Choose a year in that range."
                : `Could not load converging topic pairs (${error.message}).`}
          </p>
        )}

        {!data && !error && (
          <div aria-busy="true" className="mt-5 border border-rule">
            <p className="sr-only">Loading converging topic pairs</p>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-[34px] border-b border-rule bg-rule/30 last:border-b-0" />
            ))}
          </div>
        )}

        {data && data.total === 0 && (
          <div className="mt-5">
            {notComputed ? (
              <NotComputed analysis="Interdisciplinary connections" command="python -m graph.convergence" prerequisite="python -m graph.trends" />
            ) : (
              <p className="max-w-xl text-sm">
                No topic pairs converged in {year}.{" "}
                <button type="button" onClick={() => setYear(undefined)} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                  Show the latest period
                </button>
                .
              </p>
            )}
          </div>
        )}

        {data && data.total > 0 && (
          <div className="mt-5">
            {(dominant || hidden) && (
              <div className="mb-3 max-w-[68ch] text-sm">
                <label className="inline-flex items-start gap-2">
                  <input type="checkbox" checked={hidden !== undefined} onChange={() => toggleHide(dominant)} className="mt-0.5 accent-accent" />
                  <span>
                    Hide pairs containing {"\u201c"}
                    {hidden?.name ?? dominant?.name}
                    {"\u201d"}
                    {hidden === undefined && dominant ? ` (in ${dominant.pairCount} of ${items.length} pairs on this page)` : ""}
                  </span>
                </label>
                <p className="mt-1 text-muted">
                  {hidden ? `Hiding ${hiddenCount} of ${items.length} pairs on this page; ranks keep the server's numbering, so a gap marks a hidden pair. ` : ""}
                  Client-side filter over the pairs already loaded: it does not query the server again, and the total and other pages are unchanged.
                </p>
              </div>
            )}

            {visible.length > 0 ? (
              <DataTable
                columns={columns}
                rows={visible}
                rowKey={pairKey}
                onRowActivate={selectPair}
                caption={`Converging topic pairs${y === undefined ? "" : ` in ${y}`}, ranked by convergence score${hidden ? `, excluding pairs containing ${hidden.name}` : ""}`}
              />
            ) : (
              <p className="max-w-xl text-sm">
                Every pair on this page contains {"\u201c"}
                {hidden?.name}
                {"\u201d"}. Turn the filter off to see them, or move to another page.
              </p>
            )}
            <Pagination offset={offset} limit={PAGE_SIZE} total={data.total} onPage={(o) => patch((p) => setNum(p, "offset", o || undefined), true)} />

            {visible.length > 0 && (
              <div className="mt-8">
                <PairMatrixFigure
                  pairs={visible}
                  maxScore={maxScore}
                  year={y}
                  rankFrom={offset + 1}
                  rankTo={offset + items.length}
                  hiddenTopicName={hiddenCount > 0 ? hidden?.name : undefined}
                  run={run}
                  onSelectPair={selectPair}
                />
              </div>
            )}
          </div>
        )}

      </div>

      <Drawer open={pairA !== undefined && pairB !== undefined} onClose={clearPair} title={pairA && pairB ? `${pairA.name} + ${pairB.name}` : "Pair details"}>
        {pairA && pairB && <PairTrendPanel topicAId={pairA.id} topicAName={pairA.name} topicBId={pairB.id} topicBName={pairB.name} />}
      </Drawer>
    </div>
  );
}
