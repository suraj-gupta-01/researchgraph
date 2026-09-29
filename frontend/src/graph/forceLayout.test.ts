import { describe, it, expect } from "vitest";
import { forceCluster, layoutSignature } from "./forceLayout";
import type { CommunityGraphEdge, CommunityGraphNode } from "../api/communities";

// forceCluster is the one piece of physics this codebase actually authors
// (the rest is d3-force's own forces, not tested here since the real
// package isn't available in this environment — see the phase report).
// Testing it as a bare force(alpha) call, independent of a running
// simulation, is exactly how d3 custom forces are meant to be unit-tested:
// initialize() wires the node array, then force(alpha) is one step.

interface N {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  clusterKey: number;
}

describe("forceCluster", () => {
  it("pulls same-cluster nodes toward each other's centroid", () => {
    const nodes: N[] = [
      { x: -10, y: 0, vx: 0, vy: 0, clusterKey: 1 },
      { x: 10, y: 0, vx: 0, vy: 0, clusterKey: 1 },
    ];
    const f = forceCluster(0.5);
    f.initialize(nodes as never);
    f(1); // alpha = 1, full strength
    // centroid is (0,0); each node's velocity should point back toward it.
    expect(nodes[0].vx).toBeGreaterThan(0); // was at -10, pulled toward +x
    expect(nodes[1].vx).toBeLessThan(0); // was at +10, pulled toward -x
    expect(nodes[0].vy).toBe(0);
  });

  it("leaves a lone node in a cluster with nothing to move toward", () => {
    const nodes: N[] = [{ x: 5, y: 5, vx: 0, vy: 0, clusterKey: 1 }];
    const f = forceCluster(0.5);
    f.initialize(nodes as never);
    f(1);
    expect(nodes[0].vx).toBe(0);
    expect(nodes[0].vy).toBe(0);
  });

  it("does not mix nodes from different clusters into one centroid", () => {
    const nodes: N[] = [
      { x: 0, y: 0, vx: 0, vy: 0, clusterKey: 1 },
      { x: 100, y: 100, vx: 0, vy: 0, clusterKey: 2 },
    ];
    const f = forceCluster(0.5);
    f.initialize(nodes as never);
    f(1);
    // Each is alone in its own cluster, so neither should move at all —
    // if they were wrongly pooled, both would be pulled toward (50,50).
    expect(nodes[0].vx).toBe(0);
    expect(nodes[1].vx).toBe(0);
  });

  it("scales the pull by both strength and alpha", () => {
    const make = (): N[] => [
      { x: -10, y: 0, vx: 0, vy: 0, clusterKey: 1 },
      { x: 10, y: 0, vx: 0, vy: 0, clusterKey: 1 },
    ];
    const weak = make();
    const fWeak = forceCluster(0.1);
    fWeak.initialize(weak as never);
    fWeak(1);

    const strong = make();
    const fStrong = forceCluster(0.9);
    fStrong.initialize(strong as never);
    fStrong(1);

    expect(Math.abs(strong[0].vx!)).toBeGreaterThan(Math.abs(weak[0].vx!));
  });
});

describe("layoutSignature", () => {
  const n = (id: number): CommunityGraphNode => ({
    author_id: id,
    full_name: `A${id}`,
    community_id: null,
    membership_score: null,
    paper_count: 1,
    bridge_score: null,
    communities_touched: null,
  });
  const e = (s: number, t: number): CommunityGraphEdge => ({ source: s, target: t, weight: 1, signals: { coauthor: 1, citation: 0, topic: 0, institution: 0 } });

  it("is identical for the same node and edge set", () => {
    expect(layoutSignature([n(1), n(2)], [e(1, 2)])).toBe(layoutSignature([n(1), n(2)], [e(1, 2)]));
  });
  it("changes when a node or an edge changes", () => {
    const base = layoutSignature([n(1), n(2)], [e(1, 2)]);
    expect(layoutSignature([n(1), n(2), n(3)], [e(1, 2)])).not.toBe(base);
    expect(layoutSignature([n(1), n(2)], [])).not.toBe(base);
  });
});
