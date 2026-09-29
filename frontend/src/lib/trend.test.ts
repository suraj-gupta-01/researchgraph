import { describe, it, expect } from "vitest";
import {
  asTrendLabel,
  boardSparkPoints,
  buildYearSlots,
  describeSlot,
  formatAxisPercent,
  formatGrowth,
  growthAxisMax,
  growthMark,
  isNewGrowth,
  latestClassified,
  niceScale,
  parseTrendAlgorithm,
  ruleSentence,
  tickYears,
  type SnapshotPoint,
} from "./trend";

const pt = (year: number, paper_count: number, growth_rate: number | null, trend_label: string | null = null): SnapshotPoint => ({
  year,
  paper_count,
  author_count: paper_count,
  institution_count: 1,
  citation_count: 0,
  growth_rate,
  trend_label,
  score: growth_rate,
});

describe("parseTrendAlgorithm", () => {
  it("reads the thresholds from the stored algorithm string", () => {
    expect(parseTrendAlgorithm("growth_rate(em=0.3,dec=-0.3,min=3)")).toEqual({ emerging: 0.3, declining: -0.3, minPapers: 3 });
  });
  it("returns null for a missing or unrecognised string instead of guessing", () => {
    expect(parseTrendAlgorithm(null)).toBeNull();
    expect(parseTrendAlgorithm("")).toBeNull();
    expect(parseTrendAlgorithm("cooccurrence_growth(conv=0.3,min=3)")).toBeNull();
    expect(parseTrendAlgorithm("growth_rate(em=abc,dec=-0.3,min=3)")).toBeNull();
  });
});

describe("ruleSentence", () => {
  const rule = { emerging: 0.3, declining: -0.3, minPapers: 3 };
  it("states the emerging rule from the parsed thresholds", () => {
    expect(ruleSentence(rule, "emerging")).toContain("at least +30% on the previous year, with at least 3 papers in the year");
  });
  it("states the declining rule as a fall", () => {
    expect(ruleSentence(rule, "declining")).toContain("a fall of at least 30%");
  });
  it("says the thresholds are unavailable when there is no rule", () => {
    expect(ruleSentence(null, "emerging")).toContain("could not be read");
  });
});

describe("growth rate disambiguation", () => {
  it("treats 2.0 as new only when there was no prior year", () => {
    expect(isNewGrowth(2.0, 0)).toBe(true);
    expect(isNewGrowth(2.0, 3)).toBe(false);
    expect(formatGrowth(2.0, 0)).toBe("new");
  });
  it("shows a genuine +200% (3 papers to 9) as a percentage", () => {
    expect(formatGrowth(2.0, 3)).toBe("+200%");
  });
  it("formats ordinary and missing rates", () => {
    expect(formatGrowth(0.36, 10)).toBe("+36%");
    expect(formatGrowth(-0.5, 10)).toBe("-50%");
    expect(formatGrowth(null, 10)).toBe("Not computed");
  });
  it("never renders an axis value of 2.0 as new", () => {
    expect(formatAxisPercent(2)).toBe("+200%");
    expect(formatAxisPercent(0)).toBe("0%");
    expect(formatAxisPercent(-0.3)).toBe("-30%");
  });
});

describe("buildYearSlots", () => {
  it("fills a dormant year with an empty slot, never a zero", () => {
    const slots = buildYearSlots([pt(2021, 4, 2.0), pt(2023, 6, 2.0)]);
    expect(slots.map((s) => s.year)).toEqual([2021, 2022, 2023]);
    expect(slots[1].point).toBeNull();
    expect(slots[2].prior).toBeNull(); // 2022 has no row
  });
  it("links each slot to the previous calendar year's row", () => {
    const slots = buildYearSlots([pt(2021, 4, 2.0), pt(2022, 6, 0.5)]);
    expect(slots[1].prior?.paper_count).toBe(4);
  });
  it("returns no slots for no points", () => {
    expect(buildYearSlots([])).toEqual([]);
  });
});

describe("growthMark", () => {
  it("marks the first year and a year after a gap as new", () => {
    const slots = buildYearSlots([pt(2021, 4, 2.0), pt(2023, 6, 2.0)]);
    expect(growthMark(slots[0])).toEqual({ kind: "new" });
    expect(growthMark(slots[2])).toEqual({ kind: "new" });
  });
  it("keeps a real +200% as a value when the prior year exists", () => {
    const slots = buildYearSlots([pt(2021, 3, 2.0), pt(2022, 9, 2.0)]);
    expect(growthMark(slots[1])).toEqual({ kind: "value", rate: 2.0 });
  });
  it("has no mark when growth has not been computed or the year is a gap", () => {
    const slots = buildYearSlots([pt(2021, 4, null), pt(2023, 6, 0.1)]);
    expect(growthMark(slots[0])).toEqual({ kind: "none" });
    expect(growthMark(slots[1])).toEqual({ kind: "none" });
  });
});

describe("labels", () => {
  it("narrows API strings to the four known labels", () => {
    expect(asTrendLabel("Emerging")).toBe("Emerging");
    expect(asTrendLabel("Converging")).toBe("Converging");
    expect(asTrendLabel("Bogus")).toBeNull();
    expect(asTrendLabel(null)).toBeNull();
  });
  it("finds the latest classified year", () => {
    const slots = buildYearSlots([pt(2021, 4, 2.0, "Stable"), pt(2022, 6, 0.5, "Emerging"), pt(2023, 6, null, null)]);
    expect(latestClassified(slots)?.year).toBe(2022);
    expect(latestClassified(buildYearSlots([pt(2021, 4, null)]))).toBeNull();
  });
});

describe("describeSlot", () => {
  it("describes a gap as no papers tagged", () => {
    const slots = buildYearSlots([pt(2021, 4, 2.0), pt(2023, 6, 0.5)]);
    expect(describeSlot(slots[1])).toBe("2022: no papers tagged");
  });
  it("includes count, growth and label", () => {
    const slots = buildYearSlots([pt(2021, 10, 2.0), pt(2022, 14, 0.4, "Emerging")]);
    expect(describeSlot(slots[1])).toBe("2022: 14 papers, +40% on the year before, Emerging");
    expect(describeSlot(slots[0])).toBe("2021: 10 papers, new, no papers the year before");
  });
});

describe("scales", () => {
  it("keeps the growth axis at least +100% and clear of the emerging threshold", () => {
    expect(growthAxisMax(null)).toBe(1);
    expect(growthAxisMax({ emerging: 0.3, declining: -0.3, minPapers: 3 })).toBe(1);
    expect(growthAxisMax({ emerging: 0.8, declining: -0.3, minPapers: 3 })).toBe(1.6);
  });
  it("builds a zero-based integer count axis", () => {
    const s = niceScale(41);
    expect(s.ticks[0]).toBe(0);
    expect(s.max).toBeGreaterThanOrEqual(41);
    expect(s.ticks.every(Number.isInteger)).toBe(true);
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(1)).toEqual({ max: 1, ticks: [0, 1] });
  });
  it("thins year ticks as columns grow", () => {
    const years = (n: number) => Array.from({ length: n }, (_, i) => 2000 + i);
    expect(tickYears(years(8))).toHaveLength(8);
    expect(tickYears(years(20))).toHaveLength(10);
    expect(tickYears(years(40))).toHaveLength(8);
  });
  it("thins year ticks further when columns are too narrow for the labels", () => {
    const years = Array.from({ length: 10 }, (_, i) => 2016 + i);
    expect(tickYears(years, 60)).toHaveLength(10);
    expect(tickYears(years, 33)).toEqual([2016, 2018, 2020, 2022, 2024]);
    expect(tickYears(years, 10)).toEqual([2016, 2021]);
  });
});

describe("boardSparkPoints", () => {
  it("makes the prior year a gap when it has no snapshot", () => {
    expect(boardSparkPoints({ year: 2025, paper_count: 9, prior_year_paper_count: 0 })).toEqual([
      { year: 2024, value: null },
      { year: 2025, value: 9 },
    ]);
    expect(boardSparkPoints({ year: 2025, paper_count: 9, prior_year_paper_count: 4 })[0].value).toBe(4);
  });
});
