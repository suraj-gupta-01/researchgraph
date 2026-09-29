import { useEffect, useState } from "react";
import PairTrendChart from "../../charts/PairTrendChart";
import DataTable, { type Column } from "../../components/DataTable";
import Figure from "../../components/Figure";
import NotComputed from "../../components/NotComputed";
import TrendBadge from "../../components/TrendBadge";
import { ApiError } from "../../api/client";
import { topicPairTrend, type TopicPairTrend, type TopicPairTrendPoint } from "../../api/topics";
import { buildPairYearSlots } from "../../lib/convergence";
import { formatCount } from "../../lib/format";
import { formatGrowth, isNewGrowth } from "../../lib/trend";

interface Props {
  topicAId: number;
  topicAName: string;
  topicBId: number;
  topicBName: string;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "topic-pair"
  );
}

/**
 * F5's pair drawer (references/phases.md Phase 6b): one pair's full
 * co-occurrence trajectory, opened by activating a row on the Connections
 * board. Self-fetching and owns every state, like InfluencePanel and
 * TopicTrendPanel -- consumes GET /topics/pairs/{a}/{b}/trend (gap G3),
 * the only place a pair's own `algorithm` is available (api-coverage.md
 * §4 G4: /topics/converging rows carry none).
 */
export default function PairTrendPanel({ topicAId, topicAName, topicBId, topicBName }: Props) {
  const [data, setData] = useState<TopicPairTrend | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError(null);
    topicPairTrend(topicAId, topicBId, ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [topicAId, topicBId]);

  if (error) {
    if (error.kind === "http" && error.status === 404) {
      return (
        <p role="alert" className="text-sm text-warn">
          One of these topics could not be found.
        </p>
      );
    }
    if (error.kind === "http" && error.status === 422) {
      return (
        <p role="alert" className="text-sm text-warn">
          A topic cannot be paired with itself.
        </p>
      );
    }
    return (
      <p role="alert" className="text-sm text-warn">
        {error.kind === "network" ? `${error.message}. Start the stack with docker compose up -d, then reload.` : `Could not load the co-occurrence trajectory (${error.message}).`}
      </p>
    );
  }

  if (!data) {
    return (
      <div aria-busy="true" className="border border-rule-strong bg-sheet p-4">
        <p className="sr-only">{`Loading the co-occurrence trajectory for ${topicAName} + ${topicBName}`}</p>
        <div className="h-40 bg-rule/30" />
      </div>
    );
  }

  if (data.points.length === 0) {
    return (
      <NotComputed
        analysis={`${data.topic_a_name} + ${data.topic_b_name}'s co-occurrence trajectory`}
        command="python -m graph.convergence"
        prerequisite="python -m graph.trends"
      />
    );
  }

  return <Loaded data={data} />;
}

function Loaded({ data }: { data: TopicPairTrend }) {
  const slots = buildPairYearSlots(data.points);
  const firstYear = data.points[0].year;
  const lastYear = data.points[data.points.length - 1].year;

  const columns: Column<TopicPairTrendPoint>[] = [
    { key: "year", label: "Year", render: (p) => String(p.year) },
    { key: "now", label: "Shared papers", align: "right", render: (p) => formatCount(p.cooccurrence_count) },
    {
      key: "prior",
      label: "Shared papers the year before",
      align: "right",
      render: (p) => (p.prior_cooccurrence_count > 0 ? formatCount(p.prior_cooccurrence_count) : <span className="text-muted">none</span>),
    },
    { key: "growth", label: "Growth", align: "right", render: (p) => formatGrowth(p.growth_rate, p.prior_cooccurrence_count) },
    {
      key: "trend",
      label: "Trend",
      render: (p) => (p.is_converging ? <TrendBadge label="Converging" isNew={isNewGrowth(p.growth_rate, p.prior_cooccurrence_count)} /> : <span className="text-muted">Stable</span>),
    },
  ];

  const csv = {
    filename: `${slug(data.topic_a_name)}-${slug(data.topic_b_name)}-trend.csv`,
    headers: ["year", "cooccurrence_count", "prior_cooccurrence_count", "growth_rate", "is_converging"],
    rows: data.points.map((p) => [p.year, p.cooccurrence_count, p.prior_cooccurrence_count, p.growth_rate, String(p.is_converging)]),
  };

  return (
    <Figure
      title="Co-occurrence trajectory"
      caption={`${data.topic_a_name} + ${data.topic_b_name}, ${firstYear === lastYear ? firstYear : `${firstYear} to ${lastYear}`}.`}
      svg={<PairTrendChart slots={slots} />}
      tableView={<DataTable columns={columns} rows={data.points} rowKey={(p) => p.year} caption={`Shared-paper counts by year for ${data.topic_a_name} + ${data.topic_b_name}`} />}
      csv={csv}
      method={{
        algorithm: data.algorithm,
        explanation:
          "Convergence score mirrors this pair's own year-over-year growth in shared papers, the same growth-rate formula and \u201cnew pair\u201d convention as a single topic's trend. A year is marked Converging once the pair clears both a co-occurrence floor and a growth threshold in that year.",
      }}
    />
  );
}
