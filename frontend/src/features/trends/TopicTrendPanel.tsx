import { useEffect, useMemo, useState } from "react";
import Figure from "../../components/Figure";
import DataTable, { type Column } from "../../components/DataTable";
import NoticeBar from "../../components/NoticeBar";
import NotComputed from "../../components/NotComputed";
import TrendBadge from "../../components/TrendBadge";
import TopicTrendChart from "../../charts/TopicTrendChart";
import { ApiError } from "../../api/client";
import { topicTrend, type TopicTrend } from "../../api/topics";
import { formatCount, formatYearRange } from "../../lib/format";
import {
  asTrendLabel,
  buildYearSlots,
  formatAxisPercent,
  formatGrowth,
  growthAxisMax,
  growthMark,
  latestClassified,
  parseTrendAlgorithm,
  type YearSlot,
} from "../../lib/trend";

interface Props {
  topicId: number;
  /** Drawn in the accent color, for example the board's selected year. */
  highlightYear?: number;
}

/** The topic-over-time figure for one topic: loads /topics/{id}/trend and
 * owns every state (loading, error, not computed, degraded, ready). Used on
 * the topic page and in the Trends board's drawer. */
export default function TopicTrendPanel({ topicId, highlightYear }: Props) {
  const [data, setData] = useState<TopicTrend | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError(null);
    topicTrend(topicId, ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [topicId]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-warn">
        {error.kind === "http" && error.status === 404
          ? "This topic could not be found."
          : error.kind === "network"
            ? `${error.message}. Start the stack with docker compose up -d, then reload.`
            : `Could not load the trend for this topic (${error.message}).`}
      </p>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true" className="border border-rule-strong bg-sheet p-4">
        <p className="sr-only">Loading trend</p>
        <div className="h-[330px] bg-rule/30" />
      </div>
    );
  }
  if (data.points.length === 0) {
    return (
      <div>
        <NotComputed analysis="Topic trends" command="python -m graph.trends" prerequisite="python -m ingestion.extract_topics" />
        <p className="mt-2 max-w-xl text-sm text-muted">If both have already run, no papers are tagged with this topic, so it has no yearly counts.</p>
      </div>
    );
  }
  return <TrendFigure data={data} highlightYear={highlightYear} />;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic";
}

function TrendFigure({ data, highlightYear }: { data: TopicTrend; highlightYear?: number }) {
  const slots = useMemo(() => buildYearSlots(data.points), [data.points]);
  const rule = useMemo(() => parseTrendAlgorithm(data.algorithm), [data.algorithm]);

  const total = data.points.reduce((sum, p) => sum + p.paper_count, 0);
  const range = formatYearRange(slots[0].year, slots[slots.length - 1].year);
  const classified = data.points.some((p) => p.trend_label !== null);
  const latest = latestClassified(slots);
  const latestLabel = latest ? asTrendLabel(latest.point?.trend_label) : null;
  const hasConverging = slots.some((s) => asTrendLabel(s.point?.trend_label) === "Converging");

  const growthText = (s: YearSlot) => {
    const g = growthMark(s);
    return g.kind === "none" ? "Not computed" : formatGrowth(g.kind === "new" ? 2.0 : g.rate, s.prior?.paper_count ?? 0);
  };

  const latestGrowth = latest ? growthText(latest) : null;

  const columns: Column<YearSlot>[] = [
    { key: "year", label: "Year", render: (s) => s.year },
    { key: "papers", label: "Papers", align: "right", render: (s) => (s.point ? formatCount(s.point.paper_count) : "\u2014") },
    { key: "authors", label: "Authors", align: "right", render: (s) => (s.point ? formatCount(s.point.author_count) : "\u2014") },
    { key: "institutions", label: "Institutions", align: "right", render: (s) => (s.point ? formatCount(s.point.institution_count) : "\u2014") },
    { key: "citations", label: "Citations", align: "right", render: (s) => (s.point ? formatCount(s.point.citation_count) : "\u2014") },
    { key: "growth", label: "Growth", align: "right", render: (s) => (s.point ? growthText(s) : "\u2014") },
    {
      key: "label",
      label: "Trend",
      render: (s) => {
        if (!s.point) return <span className="text-muted">No papers tagged</span>;
        const label = asTrendLabel(s.point.trend_label);
        return label ? <TrendBadge label={label} /> : <span className="text-muted">Not classified</span>;
      },
    },
  ];

  const csv = {
    filename: `${slug(data.topic_name)}-trend.csv`,
    headers: ["year", "papers", "authors", "institutions", "citations", "growth", "trend"],
    rows: slots
      .filter((s) => s.point !== null)
      .map((s) => [
        s.year,
        s.point!.paper_count,
        s.point!.author_count,
        s.point!.institution_count,
        s.point!.citation_count,
        growthText(s),
        s.point!.trend_label ?? "",
      ]),
  };

  const offScale = formatAxisPercent(growthAxisMax(rule));

  return (
    <div>
      {!classified && (
        <NoticeBar kind="info">
          Yearly counts are loaded, but growth rates and trend labels have not been computed. Run <code className="font-mono text-[13px]">python -m graph.trends</code> to add them.
        </NoticeBar>
      )}
      <Figure
        title="Papers and growth by year"
        subtitle={`Hollow circle: no papers the year before. Triangle: growth above ${offScale}. Hollow mark on the axis: no papers tagged that year.`}
        caption={`Papers tagged \u201c${data.topic_name}\u201d per year, ${range ?? "one year"}, with growth on the previous year and the trend label for each year. ${formatCount(total)} tagged papers in total.`}
        svg={<TopicTrendChart slots={slots} rule={rule} highlightYear={highlightYear} />}
        tableView={<DataTable columns={columns} rows={slots} rowKey={(s) => s.year} caption={`Yearly counts and trend labels for ${data.topic_name}`} />}
        csv={csv}
        method={{
          algorithm: data.algorithm,
          explanation:
            "Growth is the change in papers tagged with this topic against the year before. A year is Emerging or Declining only when it has enough papers and the change clears the threshold. Converging replaces Stable for a year when the topic sits in a fast-rising topic pair.",
        }}
      />
      {latest && latestLabel && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 text-sm">
          <span className="text-muted">{latest.year} is the latest classified year:</span>
          <TrendBadge label={latestLabel} />
          {latestGrowth !== "Not computed" && <span>{latestGrowth === "new" ? "(new, no papers the year before)" : `(${latestGrowth} on the year before)`}</span>}
        </p>
      )}
      {hasConverging && (
        <p className="mt-1 max-w-[62ch] text-sm text-muted">Converging years come from the topic-pair analysis, not from this topic&rsquo;s own growth rate.</p>
      )}
    </div>
  );
}
