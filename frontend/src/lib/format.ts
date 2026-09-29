/**
 * Formatting helpers used across every figure and table. Centralized so a
 * convention (like the growth-rate "new" constant) is fixed in one place.
 * See references/api-coverage.md §3 "Rates" for the backend contract these
 * encode.
 */

/** growth_rate === 2.0 is the backend's fixed "no prior year" constant, not
 * +200%. Rates are clamped to [-1.0, 9.9999] server-side; render a clamped
 * value as "≥ 999%" rather than a false-precision number. */
export function formatGrowthRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "Not computed";
  if (rate === 2.0) return "new";
  const pct = rate * 100;
  if (pct >= 999) return "\u2265 999%";
  if (pct <= -100) return "-100%";
  const rounded = Math.round(pct);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}%`;
}

/** Thousands-separated integer count, locale-aware. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "\u2014";
  return n.toLocaleString();
}

/** "2018 to 2025", or a single year when the span is one year. */
export function formatYearRange(min: number | null | undefined, max: number | null | undefined): string | null {
  if (min === null || min === undefined || max === null || max === undefined) return null;
  return min === max ? `${min}` : `${min} to ${max}`;
}

/** "21 to 40 of 132" — the Pagination component's caption text. */
export function formatPageRange(offset: number, limit: number, total: number): string {
  if (total === 0) return "0 of 0";
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  return `${start} to ${end} of ${total}`;
}

/** A score (bridge score, betweenness, convergence score, …) to 2 decimals. */
export function formatScore(v: number | null | undefined): string {
  if (v === null || v === undefined) return "\u2014";
  return v.toFixed(2);
}

/** A 0..1 share as a whole-number percent. */
export function formatSharePercent(v: number | null | undefined): string {
  if (v === null || v === undefined) return "\u2014";
  return `${Math.round(v * 100)}%`;
}

/** "1 time" / "12 times" — for citation counts read as prose. */
export function formatTimes(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "time" : "times"}`;
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });

/** A run/detection date, e.g. "detected_at" or "fetched_at", as a short date. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return DATE_FMT.format(d);
}
