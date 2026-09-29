import { useEffect, useState } from "react";
import DataTable, { type Column } from "../../components/DataTable";
import Method from "../../components/Method";
import MetricBar from "../../components/MetricBar";
import NotComputed from "../../components/NotComputed";
import TieBar from "../../components/TieBar";
import { ApiError } from "../../api/client";
import { authorInfluence, type AuthorCommunityTie, type AuthorInfluence } from "../../api/authors";
import { formatCount, formatScore } from "../../lib/format";
import { METRIC_EXPLANATION, METRIC_RANGE, isUnscored, isUntouched } from "../../lib/influence";

interface Props {
  authorId: number;
  /** Community colours of the page hosting this panel (see TieBar). */
  communityColor?: (communityId: number) => string;
}

/**
 * F4 influence profile for one author: degree/betweenness/PageRank, bridge
 * score with communities_touched, the tie evidence behind that score
 * (TieBar + table), and a Method disclosure with the algorithm and run
 * date. Self-fetching and owns every state, like TopicTrendPanel, so the
 * author page (features/authors/AuthorPage.tsx) and the community-graph
 * drawer (features/communities/AuthorPeek.tsx) render the identical panel
 * from the identical request -- one source of truth for what a bridge
 * score means (references/phases.md Phase 5).
 */
export default function InfluencePanel({ authorId, communityColor }: Props) {
  const [data, setData] = useState<AuthorInfluence | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError(null);
    authorInfluence(authorId, ctl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [authorId]);

  if (error) {
    if (error.kind === "http" && error.status === 404) {
      if (isUnscored(error)) {
        return <NotComputed analysis="This author's influence profile" command="python -m graph.influence" prerequisite="python -m graph.communities" />;
      }
      return (
        <p role="alert" className="text-sm text-warn">
          This author could not be found.
        </p>
      );
    }
    return (
      <p role="alert" className="text-sm text-warn">
        {error.kind === "network" ? `${error.message}. Start the stack with docker compose up -d, then reload.` : `Could not load the influence profile (${error.message}).`}
      </p>
    );
  }

  if (!data) {
    return (
      <div aria-busy="true" className="border border-rule-strong bg-sheet p-4">
        <p className="sr-only">Loading influence profile</p>
        <div className="h-40 bg-rule/30" />
      </div>
    );
  }

  return <Loaded data={data} communityColor={communityColor} />;
}

function Loaded({ data, communityColor }: { data: AuthorInfluence; communityColor?: (communityId: number) => string }) {
  const untouched = isUntouched(data.communities_touched, data.bridge_score);

  const columns: Column<AuthorCommunityTie>[] = [
    { key: "community", label: "Community", render: (t) => (t.label ? t.label : <span className="italic text-muted">Replaced by a newer run</span>) },
    { key: "weight", label: "Tie weight", align: "right", render: (t) => formatScore(t.weight) },
    { key: "share", label: "Share", align: "right", render: (t) => `${Math.round(t.share * 100)}%` },
  ];

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricBar label="Degree centrality" value={data.degree_centrality} max={METRIC_RANGE} explanation={METRIC_EXPLANATION.degree} formatValue={formatScore} />
        <MetricBar label="Betweenness centrality" value={data.betweenness_centrality} max={METRIC_RANGE} explanation={METRIC_EXPLANATION.betweenness} formatValue={formatScore} />
        <MetricBar label="PageRank" value={data.pagerank} max={METRIC_RANGE} explanation={METRIC_EXPLANATION.pagerank} formatValue={formatScore} />
      </div>

      <div className="mt-4 border-t border-rule pt-4">
        <MetricBar label="Bridge score" value={data.bridge_score} max={METRIC_RANGE} explanation={METRIC_EXPLANATION.bridge} formatValue={formatScore} />
        <p className="mt-1 text-sm text-muted">
          Touches {formatCount(data.communities_touched)} {data.communities_touched === 1 ? "community" : "communities"}.
          {untouched && " No ties into any detected community -- this reflects the demo-scoped graph, not necessarily low influence overall."}
        </p>
      </div>

      {data.ties.length > 0 ? (
        <div className="mt-4">
          <h3 className="font-serif text-base font-semibold">Community ties</h3>
          <div className="mt-2">
            <TieBar ties={data.ties} colorOf={communityColor} />
          </div>
          <div className="mt-3">
            <DataTable columns={columns} rows={data.ties} rowKey={(t) => t.community_id} caption={`${data.full_name}'s tie weight and share per community`} />
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">No ties into a detected community.</p>
      )}

      <Method
        algorithm={data.algorithm}
        detectionDate={data.detection_date}
        explanation="Degree, betweenness and PageRank are standard network-centrality measures on the weighted collaboration graph. Bridge score is the participation coefficient: how evenly this author's ties spread across the communities Louvain detected."
      />
    </div>
  );
}
