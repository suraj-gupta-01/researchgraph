import { describe, it, expect } from "vitest";
import { buildChainTree, maxDepth, type ChainNode } from "./tree";

const node = (id: number, depth: number, parent: number): ChainNode => ({
  paper_id: id,
  title: `Paper ${id}`,
  publication_year: 2020,
  citation_count: 0,
  depth,
  parent_paper_id: parent,
});

describe("buildChainTree", () => {
  it("groups children by parent into a nested tree", () => {
    const flat = [node(2, 1, 1), node(3, 1, 1), node(4, 2, 2)];
    const tree = buildChainTree(flat, 1);
    expect(tree.map((n) => n.paper_id)).toEqual([2, 3]);
    expect(tree[0].children.map((n) => n.paper_id)).toEqual([4]);
    expect(tree[1].children).toEqual([]);
  });

  it("returns an empty tree when the root has no children", () => {
    expect(buildChainTree([], 1)).toEqual([]);
  });

  it("never infinite-loops even on a defensively cyclic input", () => {
    // Not data the backend should ever send (it de-cycles), but the
    // client-side guard must not hang regardless.
    const flat = [node(2, 1, 1), node(1, 2, 2)];
    expect(() => buildChainTree(flat, 1)).not.toThrow();
  });
});

describe("maxDepth", () => {
  it("returns the deepest depth present", () => {
    expect(maxDepth([node(2, 1, 1), node(4, 3, 3)])).toBe(3);
  });
  it("returns 0 for an empty list", () => {
    expect(maxDepth([])).toBe(0);
  });
});
