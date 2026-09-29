import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BridgeAuthor } from "../api/authors";
import TieProfileChart, { orderedSegments } from "./TieProfileChart";

const author = (author_id: number, full_name: string, ties: BridgeAuthor["ties"]): BridgeAuthor => ({
  author_id,
  full_name,
  paper_count: 5,
  degree_centrality: 1,
  betweenness_centrality: 0.02,
  pagerank: 0.02,
  bridge_score: 0.5,
  communities_touched: ties.length,
  matched_communities: null,
  ties,
});
const communities = [
  { id: 7, label: "Privacy", color: "#0072b2" },
  { id: 3, label: "Healthcare", color: "#d55e00" },
];
const a = author(1, "Ada", [
  { community_id: 3, label: "Healthcare", weight: 3, share: 0.75 },
  { community_id: 7, label: "Privacy", weight: 1, share: 0.25 },
]);

describe("orderedSegments", () => {
  it("stacks in legend order, not by share, so a community lines up on every row", () => {
    expect(orderedSegments(a, [7, 3]).map((t) => t.community_id)).toEqual([7, 3]);
  });
  it("puts communities missing from the legend last", () => {
    const b = author(2, "B", [{ community_id: 99, label: null, weight: 1, share: 0.5 }, { community_id: 3, label: "H", weight: 1, share: 0.5 }]);
    expect(orderedSegments(b, [7, 3]).map((t) => t.community_id)).toEqual([3, 99]);
  });
});

describe("TieProfileChart", () => {
  it("draws one segment per tie, coloured by community, widths by share", () => {
    const { container } = render(<TieProfileChart authors={[a]} communities={communities} rankFrom={1} />);
    const segs = [...container.querySelectorAll("rect[fill='#0072b2'], rect[fill='#d55e00']")].filter((r) => Number(r.getAttribute("height")) === 14);
    expect(segs).toHaveLength(2);
    const [privacy, health] = segs.map((r) => Number(r.getAttribute("width")));
    expect(health / privacy).toBeGreaterThan(2.5);
  });

  it("names each researcher's split for screen readers and selects on Enter", () => {
    const onSelect = vi.fn();
    render(<TieProfileChart authors={[a]} communities={communities} rankFrom={4} onSelect={onSelect} />);
    const row = screen.getByRole("button", { name: "4. Ada, bridge score 0.50: 25% Privacy, 75% Healthcare" });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(a);
  });
});
