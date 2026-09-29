import { describe, it, expect } from "vitest";
import { formatGrowthRate, formatCount, formatYearRange, formatPageRange, formatScore, formatSharePercent } from "./format";

describe("formatGrowthRate", () => {
  it("renders the no-prior-year constant as 'new'", () => {
    expect(formatGrowthRate(2.0)).toBe("new");
  });
  it("renders null/undefined as Not computed", () => {
    expect(formatGrowthRate(null)).toBe("Not computed");
    expect(formatGrowthRate(undefined)).toBe("Not computed");
  });
  it("renders positive and negative rates with a sign", () => {
    expect(formatGrowthRate(0.5)).toBe("+50%");
    expect(formatGrowthRate(-0.25)).toBe("-25%");
    expect(formatGrowthRate(0)).toBe("0%");
  });
  it("clamps a maxed-out rate to \u2265 999%", () => {
    expect(formatGrowthRate(9.9999)).toBe("\u2265 999%");
  });
  it("floors a full wipeout at -100%", () => {
    expect(formatGrowthRate(-1.0)).toBe("-100%");
  });
});

describe("formatCount", () => {
  it("adds thousands separators", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });
  it("renders missing counts as an em dash", () => {
    expect(formatCount(null)).toBe("\u2014");
  });
});

describe("formatYearRange", () => {
  it("collapses a single-year span", () => {
    expect(formatYearRange(2020, 2020)).toBe("2020");
  });
  it("renders a multi-year span", () => {
    expect(formatYearRange(2018, 2025)).toBe("2018 to 2025");
  });
  it("returns null when either bound is missing", () => {
    expect(formatYearRange(null, 2025)).toBeNull();
  });
});

describe("formatPageRange", () => {
  it("renders a mid-list page", () => {
    expect(formatPageRange(20, 20, 132)).toBe("21 to 40 of 132");
  });
  it("clamps the end of the last page", () => {
    expect(formatPageRange(120, 20, 132)).toBe("121 to 132 of 132");
  });
  it("renders zero total distinctly", () => {
    expect(formatPageRange(0, 20, 0)).toBe("0 of 0");
  });
});

describe("formatScore / formatSharePercent", () => {
  it("formats a score to 2 decimals", () => {
    expect(formatScore(0.0412)).toBe("0.04");
  });
  it("formats a share as a whole percent", () => {
    expect(formatSharePercent(0.6)).toBe("60%");
  });
});
