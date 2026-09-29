import { describe, it, expect } from "vitest";
import { ApiError } from "../api/client";
import { isUnscored, isUntouched, METRIC_RANGE } from "./influence";

describe("isUnscored", () => {
  it("is true for the graph.influence-hasn't-run 404", () => {
    const err = new ApiError("API returned 404 for /authors/9/influence", "http", 404, {
      detail: "No influence score for this author yet -- has graph.influence run?",
    });
    expect(isUnscored(err)).toBe(true);
  });

  it("is false for a plain author-not-found 404", () => {
    const err = new ApiError("API returned 404 for /authors/9/influence", "http", 404, { detail: "Author not found" });
    expect(isUnscored(err)).toBe(false);
  });

  it("is false when the body has no detail string at all", () => {
    const err = new ApiError("API returned 404 for /authors/9/influence", "http", 404, undefined);
    expect(isUnscored(err)).toBe(false);
  });

  it("is case-insensitive", () => {
    const err = new ApiError("x", "http", 404, { detail: "...has GRAPH.INFLUENCE run?" });
    expect(isUnscored(err)).toBe(true);
  });
});

describe("isUntouched", () => {
  it("is true only when both communities_touched and bridge_score are zero", () => {
    expect(isUntouched(0, 0)).toBe(true);
    expect(isUntouched(0, 0.01)).toBe(false);
    expect(isUntouched(2, 0)).toBe(false);
    expect(isUntouched(3, 0.4)).toBe(false);
  });
});

describe("METRIC_RANGE", () => {
  it("is the metrics' shared theoretical 0..1 bound", () => {
    expect(METRIC_RANGE).toBe(1);
  });
});
