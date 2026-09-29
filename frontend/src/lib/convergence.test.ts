import { describe, it, expect } from "vitest";
import type { ConvergingTopicPair } from "../api/topics";
import {
  CONVERGENCE_ALGORITHM_NOTE,
  convergenceRun,
  CONVERGENCE_LIMITATION,
  MAX_MATRIX_TOPICS,
  buildPairMatrix,
  buildPairYearSlots,
  describePairCell,
  describePairSlot,
  filterPairsByTopic,
  isNotComputed,
  mostFrequentTopic,
  pairKey,
  pairSparkPoints,
  rampColor,
  scoreShade,
  topicFrequencies,
} from "./convergence";

describe("isNotComputed", () => {
  it("is true only for an empty result at the default (no year requested)", () => {
    expect(isNotComputed(0, undefined)).toBe(true);
  });

  it("is false for an empty result when a specific year was requested", () => {
    expect(isNotComputed(0, 2023)).toBe(false);
  });

  it("is false whenever there are rows", () => {
    expect(isNotComputed(3, undefined)).toBe(false);
    expect(isNotComputed(3, 2023)).toBe(false);
  });
});

describe("pairSparkPoints", () => {
  it("plots the prior year and the current year", () => {
    const points = pairSparkPoints({ year: 2024, cooccurrence_count: 12, prior_cooccurrence_count: 5 });
    expect(points).toEqual([
      { year: 2023, value: 5 },
      { year: 2024, value: 12 },
    ]);
  });

  it("treats a zero prior count as a gap, not a zero bar", () => {
    const points = pairSparkPoints({ year: 2024, cooccurrence_count: 8, prior_cooccurrence_count: 0 });
    expect(points[0]).toEqual({ year: 2023, value: null });
  });
});

describe("rampColor", () => {
  it("returns the soft accent at 0 and the full accent at 1", () => {
    expect(rampColor(0)).toBe("rgb(227, 236, 247)");
    expect(rampColor(1)).toBe("rgb(29, 79, 145)");
  });

  it("clamps out-of-range input", () => {
    expect(rampColor(-0.5)).toBe(rampColor(0));
    expect(rampColor(1.5)).toBe(rampColor(1));
  });

  it("is monotonic between the two ends", () => {
    const mid = rampColor(0.5);
    expect(mid).not.toBe(rampColor(0));
    expect(mid).not.toBe(rampColor(1));
  });
});

describe("pairKey", () => {
  it("formats the canonical (low, high) order as a stable string", () => {
    expect(pairKey({ topic_a_id: 3, topic_b_id: 9 })).toBe("3-9");
  });
});

describe("buildPairYearSlots", () => {
  it("fills a dormant year as a gap, not a zero bar", () => {
    const slots = buildPairYearSlots([
      { year: 2021, cooccurrence_count: 4, prior_cooccurrence_count: 0, growth_rate: 2.0, is_converging: false },
      { year: 2023, cooccurrence_count: 9, prior_cooccurrence_count: 0, growth_rate: 2.0, is_converging: true },
    ]);
    expect(slots.map((s) => s.year)).toEqual([2021, 2022, 2023]);
    expect(slots[1].point).toBeNull();
    expect(slots[2].point?.is_converging).toBe(true);
  });

  it("is empty for no points", () => {
    expect(buildPairYearSlots([])).toEqual([]);
  });
});

describe("describePairSlot", () => {
  it("describes a gap year as no shared papers", () => {
    expect(describePairSlot({ year: 2022, point: null })).toBe("2022: no shared papers");
  });

  it("names the count, growth, and Converging status for a classified year", () => {
    const text = describePairSlot({
      year: 2023,
      point: { year: 2023, cooccurrence_count: 9, prior_cooccurrence_count: 4, growth_rate: 1.25, is_converging: true },
    });
    expect(text).toBe("2023: 9 shared papers, +125% on the year before, Converging");
  });

  it("uses the singular for a count of one and omits the Converging suffix when stable", () => {
    const text = describePairSlot({
      year: 2023,
      point: { year: 2023, cooccurrence_count: 1, prior_cooccurrence_count: 0, growth_rate: 2.0, is_converging: false },
    });
    expect(text).toBe("2023: 1 shared paper, new on the year before");
  });
});

// ---- Phase 6c -----------------------------------------------------------------

const mk = (a: number, b: number, score = 1, prior = 4, count = 9): ConvergingTopicPair => ({
  topic_a_id: a,
  topic_a_name: `T${a}`,
  topic_b_id: b,
  topic_b_name: `T${b}`,
  year: 2025,
  cooccurrence_count: count,
  prior_cooccurrence_count: prior,
  growth_rate: score,
  convergence_score: score,
});

describe("topicFrequencies / mostFrequentTopic", () => {
  it("counts how many pairs each topic appears in, most frequent first", () => {
    const f = topicFrequencies([mk(1, 2), mk(1, 3), mk(4, 5), mk(1, 6)]);
    expect(f[0]).toEqual({ id: 1, name: "T1", pairCount: 3 });
    expect(f.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("breaks ties by name then id, independent of row order", () => {
    const a = topicFrequencies([mk(2, 3), mk(4, 5)]).map((t) => t.id);
    const b = topicFrequencies([mk(4, 5), mk(2, 3)]).map((t) => t.id);
    expect(a).toEqual(b);
  });

  it("returns the top topic only when it repeats", () => {
    expect(mostFrequentTopic([mk(1, 2), mk(1, 3)])).toMatchObject({ id: 1, pairCount: 2 });
    expect(mostFrequentTopic([mk(1, 2), mk(3, 4)])).toBeNull();
    expect(mostFrequentTopic([])).toBeNull();
  });
});

describe("filterPairsByTopic", () => {
  const pairs = [mk(1, 2), mk(3, 1), mk(4, 5)];

  it("drops pairs containing the topic on either side and keeps the order", () => {
    expect(filterPairsByTopic(pairs, 1).map(pairKey)).toEqual(["4-5"]);
  });

  it("is a no-op without a topic, and returns the same array", () => {
    expect(filterPairsByTopic(pairs, undefined)).toBe(pairs);
  });

  it("can remove everything", () => {
    expect(filterPairsByTopic([mk(1, 2), mk(1, 3)], 1)).toEqual([]);
  });
});

describe("buildPairMatrix", () => {
  it("mirrors each pair across the diagonal with exactly one primary cell", () => {
    const m = buildPairMatrix([mk(1, 2), mk(1, 3)]);
    expect(m.topics.map((t) => t.id)[0]).toBe(1); // hub first
    expect(m.cells).toHaveLength(4);
    expect(m.cells.filter((c) => c.primary)).toHaveLength(2);
    for (const c of m.cells) expect(c.row).not.toBe(c.col); // diagonal stays empty
    expect(m.omittedPairs).toBe(0);
  });

  it("counts, rather than silently drops, pairs whose topics miss the cap", () => {
    const pairs = [mk(1, 2), mk(1, 3), mk(1, 4), mk(5, 6)];
    const m = buildPairMatrix(pairs, 4);
    expect(m.topics).toHaveLength(4);
    expect(m.omittedTopics).toBe(2);
    expect(m.omittedPairs).toBe(1);
    expect(m.cells.filter((c) => c.primary)).toHaveLength(3);
  });

  it("caps at MAX_MATRIX_TOPICS by default", () => {
    const pairs = Array.from({ length: 25 }, (_, i) => mk(2 * i + 1, 2 * i + 2)); // 50 distinct topics
    const m = buildPairMatrix(pairs);
    expect(m.topics).toHaveLength(MAX_MATRIX_TOPICS);
    expect(m.omittedTopics).toBe(50 - MAX_MATRIX_TOPICS);
  });

  it("is empty for no pairs", () => {
    expect(buildPairMatrix([])).toEqual({ topics: [], cells: [], omittedPairs: 0, omittedTopics: 0 });
  });
});

describe("describePairCell", () => {
  it("states score, shared papers, and growth on the year before", () => {
    expect(describePairCell(mk(1, 2, 1.0, 6, 14))).toBe("T1 + T2: convergence score 1.00, 14 shared papers in 2025, +100% on the year before");
  });

  it("says a pair with no prior shared papers is new, not +200%", () => {
    expect(describePairCell(mk(1, 2, 2.0, 0, 5))).toContain("new, with no shared papers the year before");
  });

  it("keeps a genuine +200% distinct from new", () => {
    expect(describePairCell(mk(1, 2, 2.0, 3, 9))).toContain("+200% on the year before");
  });

  it("uses the singular for one shared paper", () => {
    expect(describePairCell(mk(1, 2, 1, 1, 1))).toContain("1 shared paper in 2025");
  });
});

describe("Method wording", () => {
  it("does not claim the analysis has not run, and does not invent thresholds", () => {
    expect(CONVERGENCE_ALGORITHM_NOTE).not.toMatch(/not run yet/i);
    expect(CONVERGENCE_ALGORITHM_NOTE + CONVERGENCE_LIMITATION).not.toMatch(/\d/);
  });

  it("is one sentence for the limitation", () => {
    expect(CONVERGENCE_LIMITATION.match(/[.!?](\s|$)/g)).toHaveLength(1);
  });
});

describe("scoreShade", () => {
  it("maps 0 to 0 and the page maximum to 1", () => {
    expect(scoreShade(0, 4)).toBe(0);
    expect(scoreShade(4, 4)).toBe(1);
  });

  it("keeps ordering but lifts mid scores above a linear ramp, so one outlier does not wash the rest pale", () => {
    expect(scoreShade(1, 4)).toBeGreaterThan(0.25);
    expect(scoreShade(2, 4)).toBeGreaterThan(scoreShade(1, 4));
    expect(scoreShade(2, 4)).toBeGreaterThan(0.5);
  });

  it("is safe for a missing or non-positive maximum and clamps overshoot", () => {
    expect(scoreShade(2, 0)).toBe(0);
    expect(scoreShade(-1, 4)).toBe(0);
    expect(scoreShade(9, 4)).toBe(1);
  });
});

describe("convergenceRun", () => {
  const run = (analysis: string, status: string, algorithm: string | null) => ({
    analysis, status, algorithm, source: "mongo", detected_at: "2026-01-02T00:00:00Z", params: {}, counts: {}, details: {}, postgres_rows: null,
  });

  it("returns the convergence analysis's algorithm and date", () => {
    expect(convergenceRun([run("trends", "ok", "growth_rate(x)"), run("convergence", "ok", "cooccurrence_growth(conv=0.3,min=3)")])).toEqual({
      algorithm: "cooccurrence_growth(conv=0.3,min=3)",
      detectedAt: "2026-01-02T00:00:00Z",
    });
  });

  it("keeps the Postgres-backed string for postgres_only and mismatch runs", () => {
    expect(convergenceRun([run("convergence", "postgres_only", "a")])?.algorithm).toBe("a");
    expect(convergenceRun([run("convergence", "mismatch", "b")])?.algorithm).toBe("b");
  });

  it("is undefined when the analysis has not run, has no string, or runs are unavailable", () => {
    expect(convergenceRun([run("convergence", "not_run", null)])).toBeUndefined();
    expect(convergenceRun([run("convergence", "ok", null)])).toBeUndefined();
    expect(convergenceRun([run("trends", "ok", "growth_rate(x)")])).toBeUndefined();
    expect(convergenceRun(undefined)).toBeUndefined();
  });
});
