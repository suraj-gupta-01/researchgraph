/**
 * Pure helpers for the topic-dynamics screens (Phase 3, F3). Nothing here
 * touches React or the network, so every backend convention the figures
 * depend on is unit-tested in one place (trend.test.ts). Contract source:
 * references/api-coverage.md §3 "Rates" and backend graph/trend_core.py.
 */
import type { Schemas } from "../api/client";
import type { TrendDirection } from "../api/topics";
import type { TrendLabel } from "../components/TrendBadge";
import { formatGrowthRate } from "./format";

export type SnapshotPoint = Schemas["TopicSnapshotPoint"];

// ---- the documented rule ---------------------------------------------------

export interface TrendRule {
  emerging: number; // growth-rate threshold, e.g. 0.3 for +30%
  declining: number; // e.g. -0.3
  minPapers: number; // activity floor for the classified year itself
}

const NUM = "-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?";
const ALGORITHM_RE = new RegExp(`^growth_rate\\(em=(${NUM}),dec=(${NUM}),min=(\\d+)\\)$`);

/** Reads the thresholds out of the algorithm string the backend stores on
 * every RESEARCH_TREND row, e.g. `growth_rate(em=0.3,dec=-0.3,min=3)`.
 * The UI states the rule from this string and never hard-codes the numbers
 * (design-system.md §5). Returns null for a missing or unrecognised string,
 * so a changed format degrades to "rule unavailable", not to a wrong rule. */
export function parseTrendAlgorithm(algorithm: string | null | undefined): TrendRule | null {
  if (!algorithm) return null;
  const m = ALGORITHM_RE.exec(algorithm.trim());
  if (!m) return null;
  const rule = { emerging: Number(m[1]), declining: Number(m[2]), minPapers: Number(m[3]) };
  return Object.values(rule).every(Number.isFinite) ? rule : null;
}

/** A threshold or axis value as a signed percent. Unlike formatGrowthRate it
 * never treats 2.0 as the "new" constant: an axis tick is not a measurement. */
export function formatAxisPercent(r: number): string {
  const pct = Math.round(r * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function papers(n: number): string {
  return `${n} ${n === 1 ? "paper" : "papers"}`;
}

/** The one-line rule shown above a board, in plain words. */
export function ruleSentence(rule: TrendRule | null, direction: TrendDirection): string {
  if (!rule) {
    return "The thresholds could not be read from the API. Open a topic's figure and its Method note to see them.";
  }
  const floor = `with at least ${papers(rule.minPapers)} in the year`;
  if (direction === "emerging") {
    return `Emerging means growth of at least ${formatAxisPercent(rule.emerging)} on the previous year, ${floor}. A topic with no papers in the previous year counts as new.`;
  }
  const fall = Math.abs(Math.round(rule.declining * 100));
  return `Declining means a fall of at least ${fall}% on the previous year, ${floor}.`;
}

// ---- growth rates ------------------------------------------------------------

/** The backend's fixed stand-in for "no prior year" (NEW_TOPIC_GROWTH_RATE). */
export const NEW_GROWTH_RATE = 2.0;

/** growth_rate === 2.0 means "new" only when there really was no prior year.
 * A genuine +200% (for example 3 papers to 9) computes to exactly 2.0 too,
 * so the constant alone is ambiguous; the prior-year paper count settles it. */
export function isNewGrowth(rate: number | null | undefined, priorPapers: number): boolean {
  return rate === NEW_GROWTH_RATE && priorPapers <= 0;
}

/** Growth as text: "new", a signed percent, "≥ 999%", or "Not computed". */
export function formatGrowth(rate: number | null | undefined, priorPapers: number): string {
  if (rate === NEW_GROWTH_RATE && priorPapers > 0) return "+200%";
  return formatGrowthRate(rate);
}

export type GrowthMark = { kind: "none" } | { kind: "new" } | { kind: "value"; rate: number };

// ---- one year per column -----------------------------------------------------

export interface YearSlot {
  year: number;
  /** null = the topic has no snapshot row that year: a gap, never a zero. */
  point: SnapshotPoint | null;
  /** The previous calendar year's row, when it exists. */
  prior: SnapshotPoint | null;
}

/** Every calendar year from the first to the last snapshot, with dormant
 * years present as empty slots so the chart can draw them as gaps. */
export function buildYearSlots(points: SnapshotPoint[]): YearSlot[] {
  if (points.length === 0) return [];
  const byYear = new Map<number, SnapshotPoint>();
  for (const p of points) byYear.set(p.year, p);
  const years = [...byYear.keys()];
  const first = Math.min(...years);
  const last = Math.max(...years);
  const slots: YearSlot[] = [];
  for (let year = first; year <= last; year++) {
    slots.push({ year, point: byYear.get(year) ?? null, prior: byYear.get(year - 1) ?? null });
  }
  return slots;
}

export function growthMark(slot: YearSlot): GrowthMark {
  const p = slot.point;
  if (!p || p.growth_rate === null) return { kind: "none" };
  if (isNewGrowth(p.growth_rate, slot.prior?.paper_count ?? 0)) return { kind: "new" };
  return { kind: "value", rate: p.growth_rate };
}

const LABELS: TrendLabel[] = ["Emerging", "Declining", "Converging", "Stable"];

export function asTrendLabel(v: string | null | undefined): TrendLabel | null {
  return LABELS.find((l) => l === v) ?? null;
}

/** The most recent year that carries a trend label, or null if none does. */
export function latestClassified(slots: YearSlot[]): YearSlot | null {
  for (let i = slots.length - 1; i >= 0; i--) {
    if (asTrendLabel(slots[i].point?.trend_label)) return slots[i];
  }
  return null;
}

/** Full-sentence description of one year, used for aria-labels and readouts. */
export function describeSlot(slot: YearSlot): string {
  const p = slot.point;
  if (!p) return `${slot.year}: no papers tagged`;
  const prior = slot.prior?.paper_count ?? 0;
  const g = growthMark(slot);
  const growth =
    g.kind === "none"
      ? "growth not computed"
      : g.kind === "new"
        ? "new, no papers the year before"
        : `${formatGrowth(g.rate, prior)} on the year before`;
  const label = p.trend_label ? `, ${p.trend_label}` : "";
  return `${slot.year}: ${papers(p.paper_count)}, ${growth}${label}`;
}

// ---- scales and ticks --------------------------------------------------------

/** Upper bound of the growth panel: at least +100%, or twice the emerging
 * threshold if that is larger, so the threshold line never sits on the edge.
 * Growth above this is drawn as an off-scale marker, not stretched. */
export function growthAxisMax(rule: TrendRule | null): number {
  return Math.max(1, rule ? rule.emerging * 2 : 1);
}

/** A zero-based count axis with integer ticks (paper counts are integers). */
export function niceScale(maxValue: number, targetTicks = 4): { max: number; ticks: number[] } {
  if (!(maxValue > 0)) return { max: 1, ticks: [0, 1] };
  const rough = maxValue / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow;
  const step = Math.max(1, (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow);
  const max = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let i = 0; i * step <= max; i++) ticks.push(i * step);
  return { max, ticks };
}

/** Integer years to label. Every year up to 12 columns, then every second
 * (to 24) or fifth; and when `bandPx` (pixels per year column) is given, thin
 * further so neighbouring labels never touch. */
export function tickYears(years: number[], bandPx?: number): number[] {
  const byCount = years.length <= 12 ? 1 : years.length <= 24 ? 2 : 5;
  const byWidth = bandPx !== undefined && bandPx > 0 ? Math.ceil(44 / bandPx) : 1;
  const step = [1, 2, 5, 10, 20].find((s) => s >= Math.max(byCount, byWidth)) ?? 20;
  return years.filter((_, i) => i % step === 0);
}

/** Two-point series for the board's sparkline: last year to this year, from
 * fields the board response already carries (no per-row request). A prior
 * count of 0 means "no snapshot row", so it is a gap. */
export function boardSparkPoints(t: { year: number; paper_count: number; prior_year_paper_count: number }): {
  year: number;
  value: number | null;
}[] {
  return [
    { year: t.year - 1, value: t.prior_year_paper_count > 0 ? t.prior_year_paper_count : null },
    { year: t.year, value: t.paper_count },
  ];
}
