import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import Drawer from "../../components/Drawer";
import EntityLink from "../../components/EntityLink";
import NotComputed from "../../components/NotComputed";
import Pagination from "../../components/Pagination";
import Sparkline from "../../components/Sparkline";
import { ApiError, type Page } from "../../api/client";
import { topicTrend, trendingTopics, type TrendDirection, type TrendingTopic } from "../../api/topics";
import { formatCount, formatScore } from "../../lib/format";
import { boardSparkPoints, formatGrowth, isNewGrowth, parseTrendAlgorithm, ruleSentence, type TrendRule } from "../../lib/trend";
import { getNum, getRef, setNum, setRef, type EntityRef } from "../../lib/urlState";
import TopicTrendPanel from "./TopicTrendPanel";

const PAGE_SIZE = 25;
const DIRECTIONS: { key: TrendDirection; label: string }[] = [
  { key: "emerging", label: "Emerging" },
  { key: "declining", label: "Declining" },
];
const other = (d: TrendDirection): TrendDirection => (d === "emerging" ? "declining" : "emerging");
const label = (d: TrendDirection) => (d === "emerging" ? "Emerging" : "Declining");

/** /trends: topics classified Emerging or Declining for a year, ranked by
 * growth, with the documented rule stated above the table and a topic-over-time
 * figure in a drawer. Consumes GET /topics/trending and, for the rule text and
 * the drawer, GET /topics/{id}/trend. The board is corpus-wide: the API has no
 * topic-scope filter for trends, and the page says so. */
export default function TrendsBoard() {
  const [params, setParams] = useSearchParams();
  const direction: TrendDirection = params.get("direction") === "declining" ? "declining" : "emerging";
  const year = getNum(params, "year");
  const offset = getNum(params, "offset") ?? 0;
  const selected = getRef(params, "topic", "topicName");

  const [data, setData] = useState<Page<TrendingTopic> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [rule, setRule] = useState<TrendRule | null | undefined>(undefined);
  const [otherChecked, setOtherChecked] = useState<{ total: number } | null>(null);
  const [yearDraft, setYearDraft] = useState("");

  // The board: one request per direction, year and page. Superseded requests are aborted.
  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError(null);
    trendingTopics(direction, year, offset, PAGE_SIZE, ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [direction, year, offset]);

  const resolvedYear = year ?? data?.items[0]?.year;
  useEffect(() => setYearDraft(resolvedYear === undefined ? "" : String(resolvedYear)), [resolvedYear]);

  // The board response carries no algorithm string, so the rule is read from
  // the first row's own trend (one request, not one per row).
  const firstTopicId = data?.items[0]?.topic_id;
  useEffect(() => {
    if (firstTopicId === undefined) return;
    const ctl = new AbortController();
    topicTrend(firstTopicId, ctl.signal)
      .then((t) => setRule(parseTrendAlgorithm(t.algorithm)))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setRule(null);
      });
    return () => ctl.abort();
  }, [firstTopicId]);

  // An empty default view is either "graph.trends has not run" or "nothing is
  // classified this way"; the other direction tells them apart.
  const emptyLatest = data !== null && data.total === 0 && year === undefined;
  useEffect(() => {
    setOtherChecked(null);
    if (!emptyLatest) return;
    const ctl = new AbortController();
    trendingTopics(other(direction), undefined, 0, 1, ctl.signal)
      .then((r) => setOtherChecked({ total: r.total }))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setOtherChecked({ total: 0 });
      });
    return () => ctl.abort();
  }, [emptyLatest, direction]);

  const patch = (mutate: (p: URLSearchParams) => void, keepOffset = false) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      if (!keepOffset) next.delete("offset");
      return next;
    });
  const setSelected = (ref: EntityRef | undefined) => patch((p) => setRef(p, "topic", "topicName", ref), true);
  const setYear = (y: number | undefined) => patch((p) => setNum(p, "year", y));
  const setDirection = (d: TrendDirection) => patch((p) => (d === "emerging" ? p.delete("direction") : p.set("direction", d)));

  const submitYear = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const n = Number(yearDraft);
    if (Number.isInteger(n) && n >= 1 && n <= 2100) setYear(n);
  };

  const items = data?.items ?? [];
  const hasNew = items.some((t) => isNewGrowth(t.growth_rate, t.prior_year_paper_count));
  const y = resolvedYear;

  const columns: Column<TrendingTopic>[] = [
    { key: "rank", label: "#", align: "right", render: (t) => offset + items.indexOf(t) + 1 },
    {
      key: "topic",
      label: "Topic",
      render: (t) => (
        // The name is a real link: keep row activation (drawer) from swallowing its click or Enter.
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <EntityLink kind="topic" id={t.topic_id}>
            {t.topic_name}
          </EntityLink>
        </span>
      ),
    },
    { key: "now", label: y === undefined ? "Papers this year" : `Papers in ${y}`, align: "right", render: (t) => formatCount(t.paper_count) },
    {
      key: "prior",
      label: y === undefined ? "Papers the year before" : `Papers in ${y - 1}`,
      align: "right",
      render: (t) => (t.prior_year_paper_count > 0 ? formatCount(t.prior_year_paper_count) : <span className="text-muted">none</span>),
    },
    { key: "growth", label: "Growth", align: "right", render: (t) => formatGrowth(t.growth_rate, t.prior_year_paper_count) },
    { key: "score", label: "Rank score", align: "right", render: (t) => formatScore(t.score) },
    { key: "spark", label: "Papers, year before to this year", render: (t) => <Sparkline points={boardSparkPoints(t)} /> },
  ];

  return (
    <div className="lg:flex lg:items-start lg:gap-6">
      <div className="min-w-0 flex-1 pb-16">
        <h1 className="font-serif text-[28px] font-semibold leading-tight">{label(direction)} topics</h1>
        <p className="mt-2 max-w-[68ch] text-base text-muted">
          Topics ranked by how fast their paper count {direction === "emerging" ? "grew" : "fell"} on the previous year
          {y === undefined ? "" : `, for ${y}${year === undefined ? " (the latest period classified this way)" : ""}`}. The board covers the whole corpus; the topic scope in the top bar does not filter it.
        </p>
        {items.length > 0 && rule !== undefined && <p className="mt-2 max-w-[68ch] text-sm">{ruleSentence(rule, direction)}</p>}

        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
          <div role="group" aria-label="Trend direction" className="inline-flex border border-rule-strong">
            {DIRECTIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                aria-pressed={direction === d.key}
                onClick={() => setDirection(d.key)}
                className={`px-4 py-1.5 text-sm ${direction === d.key ? "bg-accent text-white" : "bg-sheet hover:bg-accent-soft"}`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={submitYear}>
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
        </div>

        {error && (
          <p role="alert" className="mt-5 text-sm text-warn">
            {error.kind === "network"
              ? `${error.message}. Start the stack with docker compose up -d, then reload.`
              : error.status === 422
                ? "The API only accepts years from 1 to 2100. Choose a year in that range."
                : `Could not load the ${label(direction).toLowerCase()} topics (${error.message}).`}
          </p>
        )}

        {!data && !error && (
          <div aria-busy="true" className="mt-5 border border-rule">
            <p className="sr-only">Loading topics</p>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-[34px] border-b border-rule bg-rule/30 last:border-b-0" />
            ))}
          </div>
        )}

        {data && data.total === 0 && (
          <div className="mt-5">
            {year !== undefined ? (
              <p className="max-w-xl text-sm">
                No topics were classified {label(direction)} in {year}.{" "}
                <button type="button" onClick={() => setYear(undefined)} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                  Show the latest period
                </button>
                .
              </p>
            ) : otherChecked === null ? null : otherChecked.total > 0 ? (
              <p className="max-w-xl text-sm">
                No topic is classified {label(direction)} in any period, but {formatCount(otherChecked.total)} {otherChecked.total === 1 ? "is" : "are"} classified {label(other(direction))}.{" "}
                <button type="button" onClick={() => setDirection(other(direction))} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                  Show {label(other(direction)).toLowerCase()} topics
                </button>
                .
              </p>
            ) : (
              <NotComputed analysis="Emerging and declining topics" command="python -m graph.trends" prerequisite="python -m ingestion.extract_topics" />
            )}
          </div>
        )}

        {data && data.total > 0 && (
          <div className="mt-5">
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(t) => t.topic_id}
              caption={`${label(direction)} topics${y === undefined ? "" : ` in ${y}`}, ranked by growth`}
              onRowActivate={(t) => setSelected({ id: t.topic_id, name: t.topic_name })}
            />
            {hasNew && (
              <p className="mt-2 max-w-[68ch] text-sm text-muted">
                Rank score equals the growth rate. Topics with no papers the year before carry the fixed value 2.00, so they sort together above measured growth of up to +200%.
              </p>
            )}
            <Pagination offset={offset} limit={PAGE_SIZE} total={data.total} onPage={(o) => patch((p) => setNum(p, "offset", o || undefined), true)} />
          </div>
        )}
      </div>

      <Drawer open={selected !== undefined} onClose={() => setSelected(undefined)} title={selected ? `${selected.name}, topic over time` : "Topic over time"}>
        {selected && (
          <article>
            <h2 className="font-serif text-xl font-semibold leading-snug">{selected.name}</h2>
            <p className="mt-1 text-sm">
              <Link to={`/topics/${selected.id}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                Open full page
              </Link>
            </p>
            <div className="mt-4">
              <TopicTrendPanel topicId={selected.id} highlightYear={resolvedYear} />
            </div>
          </article>
        )}
      </Drawer>
    </div>
  );
}
