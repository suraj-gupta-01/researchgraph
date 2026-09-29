import { describe, it, expect } from "vitest";
import { communityKeys, isNotComputed, isValidMinCommunities, MIN_COMMUNITIES_DEFAULT } from "./bridges";


describe("communityKeys", () => {
  it("colours the largest community first, ties by id, whatever order the list came in", () => {
    const keys = communityKeys([
      { community_id: 4, label: "D", member_count: 12 },
      { community_id: 2, label: "B", member_count: 12 },
      { community_id: 9, label: null, member_count: 20 },
    ]);
    expect(keys.map((k) => k.id)).toEqual([9, 2, 4]);
    expect(keys[0].label).toBe("Community 9");
    expect(new Set(keys.map((k) => k.color)).size).toBe(3);
  });
});

describe("isValidMinCommunities", () => {
  it("accepts the documented 1-20 integer range", () => {
    expect(isValidMinCommunities(1)).toBe(true);
    expect(isValidMinCommunities(20)).toBe(true);
    expect(isValidMinCommunities(MIN_COMMUNITIES_DEFAULT)).toBe(true);
  });

  it("rejects out-of-range or non-integer values", () => {
    expect(isValidMinCommunities(0)).toBe(false);
    expect(isValidMinCommunities(21)).toBe(false);
    expect(isValidMinCommunities(2.5)).toBe(false);
  });
});

describe("isNotComputed", () => {
  it("is true only when the page is empty and no algorithm has ever run", () => {
    expect(isNotComputed(0, null)).toBe(true);
    expect(isNotComputed(0, undefined)).toBe(true);
    expect(isNotComputed(0, "")).toBe(true);
  });

  it("is false once graph.influence has run, even with zero rows for this filter", () => {
    expect(isNotComputed(0, "participation_coefficient(min_communities=2)")).toBe(false);
  });

  it("is false whenever there are rows", () => {
    expect(isNotComputed(5, null)).toBe(false);
  });
});
