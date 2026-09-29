import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AdjacencyMatrix, { groupRuns, shade } from "./AdjacencyMatrix";

const nodes = [
  { id: 1, label: "Alpha", color: "#111", group: 1 },
  { id: 2, label: "Beta", color: "#111", group: 1 },
  { id: 3, label: "Gamma", color: "#222", group: 2, marker: 0.5 },
];
const edges = [
  { source: 1, target: 2, weight: 8 },
  { source: 2, target: 3, weight: 2 },
];
const renderMatrix = (props: Partial<Parameters<typeof AdjacencyMatrix>[0]> = {}) =>
  render(<AdjacencyMatrix nodes={nodes} edges={edges} weightName="shared papers" formatWeight={String} ariaLabel="Test matrix" idleStatus="idle" {...props} />);

describe("shade", () => {
  it("is 0 for no tie, 1 for the strongest, and square-root in between", () => {
    expect(shade(0, 8)).toBe(0);
    expect(shade(8, 8)).toBe(1);
    expect(shade(2, 8)).toBeCloseTo(0.5);
  });
});

describe("groupRuns", () => {
  it("finds runs of 2+ consecutive rows in one group, ignoring ungrouped rows", () => {
    expect(groupRuns([{ group: 1 }, { group: 1 }, { group: 2 }, { group: null }, { group: null }])).toEqual([[0, 2]]);
  });
});

describe("AdjacencyMatrix", () => {
  it("draws each tie in both mirrored cells, and leaves missing ties empty", () => {
    const { container } = renderMatrix();
    // 2 ties x 2 mirrored cells; the 1-3 pair has no tie
    expect(container.querySelectorAll("g[data-weight] > rect")).toHaveLength(4);
  });

  it("hides cells below minWeight", () => {
    const { container } = renderMatrix({ minWeight: 5 });
    expect(container.querySelectorAll("g[data-weight] > rect")).toHaveLength(2);
  });

  it("names a pair and its weight on hover", () => {
    const { container } = renderMatrix();
    fireEvent.mouseEnter(container.querySelector("g[data-weight]")!);
    expect(screen.getByText("Alpha ↔ Beta: 8 shared papers")).toBeTruthy();
  });

  it("makes each row a keyboard button that selects it, and summarises its ties on focus", () => {
    const onSelect = vi.fn();
    renderMatrix({ onSelect, markerName: "bridge score" });
    const beta = screen.getByRole("button", { name: "Beta" });
    fireEvent.focus(beta);
    expect(screen.getByText("Beta: 2 ties, strongest with Alpha (8 shared papers)")).toBeTruthy();
    fireEvent.keyDown(beta, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(2);
    expect(screen.getByRole("button", { name: "Gamma, bridge score 0.50" })).toBeTruthy();
  });
});
