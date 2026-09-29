import PairMatrix from "../../charts/PairMatrix";
import DataTable, { type Column } from "../../components/DataTable";
import EntityLink from "../../components/EntityLink";
import Figure from "../../components/Figure";
import type { ConvergingTopicPair } from "../../api/topics";
import { CONVERGENCE_ALGORITHM_NOTE, CONVERGENCE_LIMITATION, buildPairMatrix, pairKey, type ConvergenceRun } from "../../lib/convergence";
import { formatCount } from "../../lib/format";
import { formatGrowth } from "../../lib/trend";

interface Props {
  /** The pairs to draw: the board's visible rows (after the client-side
   * topic filter), already on the page -- this figure makes no request. */
  pairs: ConvergingTopicPair[];
  /** The page's highest score, unfiltered, so shading matches the table. */
  maxScore: number;
  year: number | undefined;
  /** Server ranks of the first and last row on this page. */
  rankFrom: number;
  rankTo: number;
  /** Name of the topic the board is currently hiding, if any. */
  hiddenTopicName?: string;
  /** The convergence run from /meta/runs, when the board could read it. */
  run?: ConvergenceRun;
  onSelectPair: (pair: ConvergingTopicPair) => void;
}

/** Optional overview beside the ranked table (phases.md Phase 6): an
 * adjacency matrix of the pairs on the current page. Deliberately the same
 * scope as the table -- one page of the server's ranking, minus any
 * client-side hidden topic -- so the two can never disagree about which
 * pairs exist, and the caption says so. */
export default function PairMatrixFigure({ pairs, maxScore, year, rankFrom, rankTo, hiddenTopicName, run, onSelectPair }: Props) {
  const matrix = buildPairMatrix(pairs);
  const drawn = matrix.cells.filter((c) => c.primary).map((c) => c.pair);

  const columns: Column<ConvergingTopicPair>[] = [
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
    { key: "score", label: "Convergence score", align: "right", render: (p) => p.convergence_score.toFixed(2) },
    { key: "now", label: "Shared papers", align: "right", render: (p) => formatCount(p.cooccurrence_count) },
    { key: "growth", label: "Growth", align: "right", render: (p) => formatGrowth(p.growth_rate, p.prior_cooccurrence_count) },
  ];

  const csv = {
    filename: `converging-pairs-matrix${year === undefined ? "" : `-${year}`}.csv`,
    headers: ["topic_a", "topic_b", "year", "cooccurrence_count", "prior_cooccurrence_count", "growth_rate", "convergence_score"],
    rows: drawn.map((p) => [p.topic_a_name, p.topic_b_name, p.year, p.cooccurrence_count, p.prior_cooccurrence_count, p.growth_rate, p.convergence_score]),
  };

  const parts = [
    `Convergence score for ${drawn.length} converging topic pair${drawn.length === 1 ? "" : "s"} on this page (ranks ${rankFrom} to ${rankTo})${year === undefined ? "" : ` in ${year}`}, shaded on a log scale against the page's highest score.`,
    "Topics are ordered by how many of these pairs they appear in.",
    hiddenTopicName ? `Pairs containing \u201c${hiddenTopicName}\u201d are hidden.` : null,
    matrix.omittedPairs > 0
      ? `${matrix.omittedPairs} pair${matrix.omittedPairs === 1 ? " is" : "s are"} not drawn because ${matrix.omittedTopics} less-frequent topic${matrix.omittedTopics === 1 ? "" : "s"} did not fit; they are in the ranked table.`
      : null,
  ].filter(Boolean);

  return (
    <Figure
      title="Converging pairs as a matrix"
      subtitle="Which topics pair up, at a glance"
      caption={parts.join(" ")}
      svg={<PairMatrix matrix={matrix} maxScore={maxScore} onSelectPair={onSelectPair} />}
      tableView={<DataTable columns={columns} rows={drawn} rowKey={pairKey} caption="Pairs drawn in the matrix, with convergence score" />}
      csv={csv}
      method={{
        algorithm: run?.algorithm ?? null,
        algorithmNote: CONVERGENCE_ALGORITHM_NOTE,
        detectionDate: run?.detectedAt,
        explanation: `Each filled cell is one converging pair from this page of the ranked list, mirrored across the diagonal so it reads from either topic. It shows these pairs only, not every topic pair in the corpus. ${CONVERGENCE_LIMITATION}`,
      }}
    />
  );
}
