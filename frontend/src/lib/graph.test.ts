import { describe, it, expect } from "vitest";
import {
  bridgeRingWidth,
  buildAdjacency,
  buildLegend,
  clampZoom,
  edgeOpacity,
  matchesIsolation,
  nodeRadius,
  tabOrder,
  COMMUNITY_PALETTE,
  COMMUNITY_NONE_COLOR,
} from "./graph";
import type { CommunityGraphEdge, CommunityGraphNode } from "../api/communities";

const node = (author_id: number, community_id: number | null, paper_count = 1, bridge_score: number | null = null): CommunityGraphNode => ({
  author_id,
  full_name: `Author ${author_id}`,
  community_id,
  membership_score: community_id !== null ? 0.5 : null,
  paper_count,
  bridge_score,
  communities_touched: bridge_score !== null ? 2 : null,
});

describe("nodeRadius", () => {
  it("scales as sqrt(paper_count) between 4 and 16 px", () => {
    expect(nodeRadius(0, 100)).toBe(4);
    expect(nodeRadius(100, 100)).toBe(16);
    expect(nodeRadius(25, 100)).toBeCloseTo(4 + 0.5 * 12); // sqrt(25/100) = 0.5
  });
  it("never divides by zero when every node has 0 papers", () => {
    expect(nodeRadius(0, 0)).toBe(4);
  });
});

describe("bridgeRingWidth", () => {
  it("draws no ring for null or zero bridge score", () => {
    expect(bridgeRingWidth(null)).toBe(0);
    expect(bridgeRingWidth(0)).toBe(0);
  });
  it("scales with score and saturates at the top of the range", () => {
    expect(bridgeRingWidth(1)).toBeCloseTo(3.5);
    expect(bridgeRingWidth(2)).toBeCloseTo(3.5); // clamped, never grows past a readable stroke
  });
});

describe("edgeOpacity", () => {
  it("makes the heaviest edge fully within range and weak edges still visible", () => {
    expect(edgeOpacity(10, 10)).toBeCloseTo(0.8);
    expect(edgeOpacity(0, 10)).toBeCloseTo(0.12);
  });
  it("falls back to a flat low opacity when every edge weighs nothing", () => {
    expect(edgeOpacity(0, 0)).toBe(0.15);
  });
});

describe("buildLegend", () => {
  const labels = new Map([
    [1, "Federated Learning + Privacy"],
    [2, "Federated Learning + Healthcare"],
  ]);

  it("colors communities by size in this graph, largest first", () => {
    const nodes = [node(1, 1), node(2, 1), node(3, 1), node(4, 2)];
    const { legend, colorOf } = buildLegend(nodes, labels);
    expect(legend[0]).toMatchObject({ communityId: 1, label: "Federated Learning + Privacy", memberCount: 3 });
    expect(legend[1]).toMatchObject({ communityId: 2, label: "Federated Learning + Healthcare", memberCount: 1 });
    expect(colorOf(1)).toBe(COMMUNITY_PALETTE[0]);
    expect(colorOf(2)).toBe(COMMUNITY_PALETTE[1]);
  });

  it("names an unlabeled community by number rather than leaving it blank", () => {
    const { legend } = buildLegend([node(1, 9)], new Map());
    expect(legend[0].label).toBe("Community 9");
  });

  it("keeps the 8 largest colored and buckets the rest as grey Other communities", () => {
    const nodes = Array.from({ length: 9 }, (_, i) => node(i, i + 1, 9 - i)); // community i+1 sized 9-i
    const { legend, colorOf } = buildLegend(nodes, new Map());
    expect(legend).toHaveLength(9); // 8 colored + 1 "Other"
    expect(legend.slice(0, 8).every((e) => COMMUNITY_PALETTE.includes(e.color))).toBe(true);
    const other = legend[8];
    expect(other).toMatchObject({ communityId: null, label: "Other communities", isOther: true, memberCount: 1 });
    expect(other.color).toBe(COMMUNITY_NONE_COLOR);
    expect(colorOf(9)).toBe(COMMUNITY_NONE_COLOR); // the smallest, bucketed community
  });

  it("lists unassigned authors separately from Other communities, both grey", () => {
    const nodes = [node(1, 1), node(2, null), node(3, null)];
    const { legend, colorOf } = buildLegend(nodes, labels);
    const unassigned = legend.find((e) => e.label === "Unassigned");
    expect(unassigned).toMatchObject({ memberCount: 2, isOther: false, color: COMMUNITY_NONE_COLOR });
    expect(colorOf(null)).toBe(COMMUNITY_NONE_COLOR);
  });

  it("omits empty buckets", () => {
    const { legend } = buildLegend([node(1, 1)], labels);
    expect(legend.some((e) => e.label === "Unassigned")).toBe(false);
    expect(legend.some((e) => e.isOther)).toBe(false);
  });
});

describe("buildAdjacency", () => {
  const edge = (source: number, target: number, weight = 1): CommunityGraphEdge => ({
    source,
    target,
    weight,
    signals: { coauthor: weight, citation: 0, topic: 0, institution: 0 },
  });

  it("is symmetric: an edge links both endpoints to each other", () => {
    const adj = buildAdjacency([edge(1, 2), edge(2, 3)]);
    expect(adj.get(1)).toEqual(new Set([2]));
    expect(adj.get(2)).toEqual(new Set([1, 3]));
    expect(adj.get(3)).toEqual(new Set([2]));
  });
  it("has no entry for a node with no edges", () => {
    expect(buildAdjacency([]).get(1)).toBeUndefined();
  });
});

describe("tabOrder", () => {
  it("orders by legend rank first, then weighted degree within a community", () => {
    const nodes = [node(1, 2, 1), node(2, 1, 1), node(3, 1, 1)];
    const edges: CommunityGraphEdge[] = [
      { source: 2, target: 3, weight: 5, signals: { coauthor: 5, citation: 0, topic: 0, institution: 0 } },
      { source: 2, target: 1, weight: 1, signals: { coauthor: 1, citation: 0, topic: 0, institution: 0 } },
    ];
    const rank = new Map([
      [1, 0],
      [2, 1],
    ]);
    const order = tabOrder(nodes, edges, rank).map((n) => n.author_id);
    expect(order).toEqual([2, 3, 1]); // community 1 (rank 0) before community 2; within it, higher weighted degree first
  });
  it("sends unassigned authors to the end", () => {
    const nodes = [node(1, null), node(2, 5)];
    const order = tabOrder(nodes, [], new Map([[5, 0]])).map((n) => n.author_id);
    expect(order).toEqual([2, 1]);
  });
});

describe("clampZoom", () => {
  it("keeps zoom within the interactive range", () => {
    expect(clampZoom(0.01)).toBe(0.2);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(1)).toBe(1);
  });
});

describe("matchesIsolation", () => {
  const colorOf = (id: number | null) => (id === 1 ? COMMUNITY_PALETTE[0] : COMMUNITY_NONE_COLOR);

  it("matches everything when nothing is isolated", () => {
    expect(matchesIsolation(node(1, 1), null, colorOf)).toBe(true);
    expect(matchesIsolation(node(2, null), null, colorOf)).toBe(true);
  });
  it("isolating a community keeps only that community's nodes", () => {
    expect(matchesIsolation(node(1, 1), 1, colorOf)).toBe(true);
    expect(matchesIsolation(node(2, 9), 1, colorOf)).toBe(false);
  });
  it("isolating 'unassigned' keeps only null-community nodes", () => {
    expect(matchesIsolation(node(1, null), "unassigned", colorOf)).toBe(true);
    expect(matchesIsolation(node(2, 1), "unassigned", colorOf)).toBe(false);
  });
  it("isolating 'other' keeps grey-colored real communities, not unassigned or the colored one", () => {
    expect(matchesIsolation(node(1, 9), "other", colorOf)).toBe(true); // grey, not in palette
    expect(matchesIsolation(node(2, 1), "other", colorOf)).toBe(false); // colored
    expect(matchesIsolation(node(3, null), "other", colorOf)).toBe(false); // unassigned, not "other"
  });
});
