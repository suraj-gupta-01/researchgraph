/**
 * Pure helpers for the Connections board (Phase 6a, F5). Contract source:
 * references/phases.md Phase 6, references/api-coverage.md §"planned
 * backend gaps" G3/G4, and backend/graph/convergence_core.py, whose
 * docstring is the reason several of these mirror lib/trend.ts: a pair's
 * growth is computed by the exact same `compute_growth_rate` formula and
 * the same "no prior period" constant as a single topic's, so the rendering
 * rules (lib/trend.ts#formatGrowth, #isNewGrowth, #NEW_GROWTH_RATE) apply
 * to a pair's `growth_rate` unchanged -- this module does not redefine them.
 */
import type { AnalysisRun } from "../api/meta";
import type { ConvergingTopicPair, TopicPairTrendPoint } from "../api/topics";
import { formatGrowth, isNewGrowth } from "./trend";

/** `GET /topics/converging` resolves an omitted `year` to
 * `MAX(Period_Year) FROM TOPIC_PAIR_TREND WHERE Is_Converging`
 * (backend/app/routers/topics.py): every row that query could find is, by
 * construction, already `Is_Converging`, so a non-null year is guaranteed
 * at least one row. An empty result for the *default* (no year requested)
 * therefore means that query found no year at all -- not "this period has
 * nothing", but "no period ever has" -- unlike the Trends board, this
 * needs no second probe request to tell the two states apart. */
export function isNotComputed(total: number, requestedYear: number | undefined): boolean {
  return total === 0 && requestedYear === undefined;
}

/** The board's own 2-point co-occurrence sparkline (design-system.md §5:
 * "a ranked table with a co-occurrence sparkline per pair is the primary
 * form"). A prior count of 0 is a genuine gap, not a zero bar -- same
 * convention as lib/trend.ts#boardSparkPoints for a topic's own paper
 * count, and the same reason: TOPIC_PAIR_TREND only exists for periods
 * with cooccurrence_count > 0 (parallel to TOPIC_SNAPSHOT), so a 0 prior
 * count means the pair simply didn't co-occur that year, not that the row
 * was measured at zero. */
export function pairSparkPoints(pair: Pick<ConvergingTopicPair, "year" | "cooccurrence_count" | "prior_cooccurrence_count">): { year: number; value: number | null }[] {
  return [
    { year: pair.year - 1, value: pair.prior_cooccurrence_count > 0 ? pair.prior_cooccurrence_count : null },
    { year: pair.year, value: pair.cooccurrence_count },
  ];
}

// design-system.md §2: "Sequential ramp for scores (bridge score,
// convergence score): interpolate #E3ECF7 to #1D4F91" -- the same two
// custom properties as --color-accent-soft and --color-accent.
const RAMP_FROM = { r: 0xe3, g: 0xec, b: 0xf7 };
const RAMP_TO = { r: 0x1d, g: 0x4f, b: 0x91 };

/** A convergence score has no fixed 0..1 range (it *is* growth_rate,
 * capped at 9.9999 -- graph/trend_core.py#GROWTH_RATE_CAP), so it is
 * normalized against the current page's own highest score, the same
 * "corpus/page range" convention MetricBar uses for centrality metrics,
 * rather than against a fixed domain. `pct` is that page-relative
 * fraction, already clamped to [0, 1]. */
export function rampColor(pct: number): string {
  const t = Math.max(0, Math.min(1, pct));
  const r = Math.round(RAMP_FROM.r + (RAMP_TO.r - RAMP_FROM.r) * t);
  const g = Math.round(RAMP_FROM.g + (RAMP_TO.g - RAMP_FROM.g) * t);
  const b = Math.round(RAMP_FROM.b + (RAMP_TO.b - RAMP_FROM.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Fraction of the ramp for a score, on a log scale against the page's
 * highest score. Convergence scores are growth rates, so a single outlier
 * (a pair going from 1 to 5 shared papers is +400%) would otherwise wash
 * every other cell pale on a linear ramp. log1p keeps 0 at 0 and the
 * page's maximum at 1, and never re-orders anything; the exact score is
 * always in the table. Used for the matrix cells and the table's score-bar
 * color, so both agree. */
export function scoreShade(score: number, max: number): number {
  if (!(max > 0) || !(score > 0)) return 0;
  return Math.max(0, Math.min(1, Math.log1p(score) / Math.log1p(max)));
}

/** A stable key for a pair that has no single id of its own -- the
 * canonical (low, high) order the backend itself stores under (mirrors
 * backend/graph/convergence_core.py#canonical_pair; `/topics/converging`
 * rows already come out in that order, this just formats it as a key). */
export function pairKey(pair: Pick<ConvergingTopicPair, "topic_a_id" | "topic_b_id">): string {
  return `${pair.topic_a_id}-${pair.topic_b_id}`;
}

// ---- pair drawer (Phase 6b, GET /topics/pairs/{a}/{b}/trend, gap G3) -------

export interface PairYearSlot {
  year: number;
  /** null = no TOPIC_PAIR_TREND row that year: a gap, never a zero bar --
   * same convention as lib/trend.ts#YearSlot for a single topic. */
  point: TopicPairTrendPoint | null;
}

/** Every calendar year from the pair's first to last co-occurring year,
 * dormant years present as empty slots. Mirrors lib/trend.ts#buildYearSlots
 * one level up (a pair's history instead of a single topic's). */
export function buildPairYearSlots(points: TopicPairTrendPoint[]): PairYearSlot[] {
  if (points.length === 0) return [];
  const byYear = new Map<number, TopicPairTrendPoint>();
  for (const p of points) byYear.set(p.year, p);
  const years = [...byYear.keys()];
  const first = Math.min(...years);
  const last = Math.max(...years);
  const slots: PairYearSlot[] = [];
  for (let year = first; year <= last; year++) {
    slots.push({ year, point: byYear.get(year) ?? null });
  }
  return slots;
}

/** Full-sentence description of one year, used for the chart's aria-labels
 * and hover/focus readout. */
export function describePairSlot(slot: PairYearSlot): string {
  const p = slot.point;
  if (!p) return `${slot.year}: no shared papers`;
  const count = `${p.cooccurrence_count} shared paper${p.cooccurrence_count === 1 ? "" : "s"}`;
  const growth = `${formatGrowth(p.growth_rate, p.prior_cooccurrence_count)} on the year before`;
  return `${slot.year}: ${count}, ${growth}${p.is_converging ? ", Converging" : ""}`;
}

// ---- Method wording (Phase 6c) ----------------------------------------------

/** The "previously separate" limitation (references/phases.md Phase 6;
 * backend/graph/convergence_core.py's KNOWN_LIMITS note): the classifier
 * only sees that a pair's shared-paper count grew, not that the two topics
 * used to be apart. One sentence, shared by every Method disclosure on the
 * Connections board so the wording cannot drift between figures. */
export const CONVERGENCE_LIMITATION =
  "A pair counts as converging when its shared papers grow, not when the two topics were previously separate, so a very common topic paired with one of its own sub-topics can rank here.";

/** `GET /topics/converging` rows carry no `algorithm` (api-coverage.md §4,
 * G4), so the board reads the run's string from `GET /meta/runs` instead
 * (`convergenceRun`). This note is the fallback for when that lookup fails
 * or has nothing to report -- and must not say "not run yet", because the
 * list only has rows if the analysis did run. `GET /topics/pairs/{a}/{b}/trend`
 * still returns the string per pair, which the pair drawer's Method shows. */
export const CONVERGENCE_ALGORITHM_NOTE = "Not reported with this list. Open a pair and read its Method for the algorithm recorded there.";

export interface ConvergenceRun {
  algorithm: string;
  detectedAt: string | null;
}

/** The convergence analysis's algorithm string and run date out of
 * `GET /meta/runs`. Every status but `not_run` carries the authoritative
 * string (`postgres_only`/`mismatch` fall back to Postgres's own stamp), so
 * only a missing run or a missing string yields `undefined`. */
export function convergenceRun(runs: AnalysisRun[] | undefined): ConvergenceRun | undefined {
  const run = runs?.find((r) => r.analysis === "convergence");
  if (!run || run.status === "not_run" || !run.algorithm) return undefined;
  return { algorithm: run.algorithm, detectedAt: run.detected_at };
}

// ---- dominant-topic filter (Phase 6c) ---------------------------------------

export interface TopicFrequency {
  id: number;
  name: string;
  /** How many of the given pairs contain this topic. */
  pairCount: number;
}

/** Every topic in `pairs` with the number of pairs it appears in, most
 * frequent first (ties by name, then id, so the order never depends on the
 * order the server happened to return rows in). Counts only what it is
 * given: on the Connections board that is the current page, not the corpus. */
export function topicFrequencies(pairs: Pick<ConvergingTopicPair, "topic_a_id" | "topic_a_name" | "topic_b_id" | "topic_b_name">[]): TopicFrequency[] {
  const byId = new Map<number, TopicFrequency>();
  const bump = (id: number, name: string) => {
    const cur = byId.get(id);
    if (cur) cur.pairCount += 1;
    else byId.set(id, { id, name, pairCount: 1 });
  };
  for (const p of pairs) {
    bump(p.topic_a_id, p.topic_a_name);
    bump(p.topic_b_id, p.topic_b_name);
  }
  return [...byId.values()].sort((x, y) => y.pairCount - x.pairCount || x.name.localeCompare(y.name) || x.id - y.id);
}

/** The topic in the most pairs on this page, or null when none repeats.
 * "The corpus's most common topic" (phases.md) is not something
 * /topics/converging can tell us -- the API has no corpus-wide count -- so
 * "dominant" is defined over the rows already loaded, and the UI says so.
 * A topic in a single pair is not dominant in any useful sense. */
export function mostFrequentTopic(pairs: Parameters<typeof topicFrequencies>[0]): TopicFrequency | null {
  const top = topicFrequencies(pairs)[0];
  return top && top.pairCount >= 2 ? top : null;
}

/** Drops every pair that contains `topicId`. Filtering only: never
 * re-orders, so the server's ranking is untouched. */
export function filterPairsByTopic<T extends Pick<ConvergingTopicPair, "topic_a_id" | "topic_b_id">>(pairs: T[], topicId: number | undefined): T[] {
  if (topicId === undefined) return pairs;
  return pairs.filter((p) => p.topic_a_id !== topicId && p.topic_b_id !== topicId);
}

// ---- adjacency matrix (Phase 6c) --------------------------------------------

/** Above this many topics the matrix stops growing (a 50 x 50 grid is a
 * screen of near-empty cells with unreadable labels). Pairs that fall
 * outside are counted and reported, never silently dropped. */
export const MAX_MATRIX_TOPICS = 30;

export interface MatrixTopic {
  id: number;
  name: string;
  pairCount: number;
}

export interface MatrixCell {
  row: number;
  col: number;
  pair: ConvergingTopicPair;
  /** The upper-triangle cell of a pair (row < col). The matrix is mirrored
   * so a pair reads from either topic, but only this cell is a tab stop:
   * one per pair, like the ranked table. */
  primary: boolean;
}

export interface PairMatrix {
  topics: MatrixTopic[];
  cells: MatrixCell[];
  /** Pairs left out because one of their topics did not make the cut. */
  omittedPairs: number;
  omittedTopics: number;
}

/** Topics x topics grid over the pairs it is given (the visible rows of the
 * current page -- no further requests, api-coverage.md ground rule 1).
 * Topics are ordered by how many of these pairs they appear in, so hub
 * topics gather in the top-left corner. */
export function buildPairMatrix(pairs: ConvergingTopicPair[], maxTopics: number = MAX_MATRIX_TOPICS): PairMatrix {
  const freqs = topicFrequencies(pairs);
  const topics = freqs.slice(0, maxTopics);
  const index = new Map(topics.map((t, i) => [t.id, i]));
  const cells: MatrixCell[] = [];
  let omittedPairs = 0;
  for (const pair of pairs) {
    const a = index.get(pair.topic_a_id);
    const b = index.get(pair.topic_b_id);
    if (a === undefined || b === undefined) {
      omittedPairs += 1;
      continue;
    }
    cells.push({ row: a, col: b, pair, primary: a < b });
    cells.push({ row: b, col: a, pair, primary: b < a });
  }
  return { topics, cells, omittedPairs, omittedTopics: freqs.length - topics.length };
}

/** Full-sentence description of one pair, for a matrix cell's aria-label
 * and hover/focus readout. Everything a tooltip could say is also in the
 * figure's table view. */
export function describePairCell(pair: ConvergingTopicPair): string {
  const shared = `${pair.cooccurrence_count} shared paper${pair.cooccurrence_count === 1 ? "" : "s"} in ${pair.year}`;
  const growth = isNewGrowth(pair.growth_rate, pair.prior_cooccurrence_count)
    ? "new, with no shared papers the year before"
    : `${formatGrowth(pair.growth_rate, pair.prior_cooccurrence_count)} on the year before`;
  return `${pair.topic_a_name} + ${pair.topic_b_name}: convergence score ${pair.convergence_score.toFixed(2)}, ${shared}, ${growth}`;
}
