import { describe, it, expect } from "vitest";
import type { CommunityGraphEdge, CommunityGraphNode } from "../api/communities";
import { membersByCohesion, summarizeCommunities, takeaway } from "./communityMap";

const node = (author_id: number, community_id: number | null): CommunityGraphNode =>
  ({ author_id, full_name: `A${author_id}`, community_id, membership_score: null, paper_count: 1, bridge_score: null, communities_touched: null }) as CommunityGraphNode;
const edge = (source: number, target: number, weight: number): CommunityGraphEdge => ({ source, target, weight, signals: {} }) as unknown as CommunityGraphEdge;

// community 1: authors 1,2,3 (3 pairs); community 2: authors 4,5 (1 pair); author 6 unassigned
const nodes = [node(1, 1), node(2, 1), node(3, 1), node(4, 2), node(5, 2), node(6, null)];
const edges = [edge(1, 2, 30), edge(1, 3, 30), edge(2, 3, 30), edge(4, 5, 20), edge(1, 4, 6), edge(3, 5, 6), edge(5, 6, 99)];

describe("summarizeCommunities", () => {
  it("averages tie strength per possible member pair, inside and between", () => {
    const s = summarizeCommunities(nodes, edges);
    expect(s.communities).toEqual([
      { id: 1, size: 3, within: 30 },
      { id: 2, size: 2, within: 20 },
    ]);
    // 12 total between over 3 x 2 = 6 pairs
    expect(s.links).toEqual([{ a: 1, b: 2, avg: 2 }]);
  });

  it("leaves unassigned researchers off the map and counts them", () => {
    expect(summarizeCommunities(nodes, edges).unassigned).toBe(1);
  });
});

describe("takeaway", () => {
  it("states the inside/between ratio", () => {
    expect(takeaway(summarizeCommunities(nodes, edges), (id) => `C${id}`)[0]).toMatch(/12\.5× more strongly tied inside/);
  });

  it("names a loosely knit community only when it stands out", () => {
    const ns = [1, 2, 3].flatMap((c) => [node(c * 10, c), node(c * 10 + 1, c)]);
    const tight = [edge(10, 11, 30), edge(20, 21, 30), edge(30, 31, 29), edge(10, 20, 5)];
    expect(takeaway(summarizeCommunities(ns, tight), (id) => `C${id}`).join(" ")).not.toMatch(/loosely knit/);
    const loose = [edge(10, 11, 30), edge(20, 21, 30), edge(30, 31, 12), edge(10, 20, 5)];
    expect(takeaway(summarizeCommunities(ns, loose), (id) => `C${id}`).join(" ")).toMatch(/C3 is the most loosely knit/);
  });
});

describe("membersByCohesion", () => {
  it("ranks members by their total tie strength inside their own community", () => {
    const e = [edge(1, 2, 10), edge(1, 3, 5), edge(1, 4, 50)];
    expect(membersByCohesion(1, nodes, e).map((m) => [m.node.author_id, m.inside])).toEqual([
      [1, 15],
      [2, 10],
      [3, 5],
    ]);
  });
});
