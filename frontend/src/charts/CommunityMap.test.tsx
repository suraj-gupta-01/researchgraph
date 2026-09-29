import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CommunityMap, { mapPositions, sharedPrefix } from "./CommunityMap";

const summary = {
  communities: [
    { id: 1, size: 12, within: 30 },
    { id: 2, size: 6, within: 15 },
  ],
  links: [{ a: 1, b: 2, avg: 10 }],
  unassigned: 0,
};
const labelOf = (id: number) => (id === 1 ? "Federated Learning + Privacy" : "Federated Learning + Healthcare");

describe("mapPositions", () => {
  it("puts four communities at the corners, not on the axes", () => {
    for (const { x, y } of mapPositions(4, 0, 0, 100, 100)) {
      expect(Math.abs(x)).toBeCloseTo(Math.abs(y));
      expect(Math.abs(x)).toBeGreaterThan(1);
    }
  });
});

describe("sharedPrefix", () => {
  it("finds a prefix every label shares at a ' + ' boundary", () => {
    expect(sharedPrefix(["FL + Privacy", "FL + Edge + IoT"])).toBe("FL + ");
    expect(sharedPrefix(["FL + Privacy", "Graphs + Privacy"])).toBe("");
    expect(sharedPrefix(["Only one + label"])).toBe("");
  });
});

describe("CommunityMap", () => {
  it("makes each community a keyboard button that toggles selection", () => {
    const onSelect = vi.fn();
    render(<CommunityMap summary={summary} labelOf={labelOf} colorOf={() => "#0072b2"} selectedId={null} onSelect={onSelect} />);
    const privacy = screen.getByRole("button", { name: "Federated Learning + Privacy: 12 members, internal tie 30.0; strongest link Federated Learning + Healthcare, 10.0" });
    fireEvent.keyDown(privacy, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("drops the shared prefix from the drawing and says so once", () => {
    render(<CommunityMap summary={summary} labelOf={labelOf} colorOf={() => "#0072b2"} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("Privacy")).toBeTruthy();
    expect(screen.getByText(/Every community here is labelled .Federated Learning \+./)).toBeTruthy();
  });

  it("prints each link's value and draws a stronger link heavier", () => {
    const three = { ...summary, communities: [...summary.communities, { id: 3, size: 6, within: 20 }], links: [{ a: 1, b: 2, avg: 10 }, { a: 1, b: 3, avg: 2 }] };
    const { container } = render(<CommunityMap summary={three} labelOf={(id) => `C${id}`} colorOf={() => "#000"} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("10.0")).toBeTruthy();
    expect(screen.getByText("2.0")).toBeTruthy();
    const w = (avg: number) => Number(container.querySelector(`line[data-link-avg="${avg}"]`)!.getAttribute("stroke-width"));
    expect(w(10)).toBeGreaterThan(w(2));
  });
});

describe("CommunityMap at other community counts", () => {
  const ring = (k: number) => {
    const communities = Array.from({ length: k }, (_, i) => ({ id: i + 1, size: 30 - i, within: 20 }));
    const links = [];
    for (let a = 1; a <= k; a++) for (let b = a + 1; b <= k; b++) links.push({ a, b, avg: 100 - a * 10 - b });
    links.sort((x, y) => y.avg - x.avg);
    return { communities, links, unassigned: 0 };
  };
  const renderRing = (k: number, selectedId: number | null = null) =>
    render(<CommunityMap summary={ring(k)} labelOf={(id) => `Topic ${id}`} colorOf={() => "#000"} selectedId={selectedId} onSelect={() => {}} />);

  it("draws at most eight communities and names the rest", () => {
    renderRing(10);
    expect(screen.getAllByRole("button")).toHaveLength(8);
    expect(screen.getByText(/2 smaller communities are not drawn: Topic 9 \(22 members\), Topic 10 \(21 members\)/)).toBeTruthy();
  });

  it("past ten links draws only the eight strongest, and all of a selected community's", () => {
    const { container, unmount } = renderRing(6); // 15 links
    expect(container.querySelectorAll("line[data-link-avg]")).toHaveLength(8);
    expect(screen.getByText(/Only the 8 strongest of 15 links are drawn/)).toBeTruthy();
    unmount();
    const selected = renderRing(6, 6);
    expect(selected.container.querySelectorAll("line[data-link-avg]")).toHaveLength(5);
  });

  it("draws every link up to ten, printing values on the six strongest", () => {
    const { container } = renderRing(5); // 10 links
    expect(container.querySelectorAll("line[data-link-avg]")).toHaveLength(10);
    expect(container.querySelectorAll("rect + text")).toHaveLength(6);
  });

  it("handles a single community: no links, full label", () => {
    render(<CommunityMap summary={{ communities: [{ id: 1, size: 5, within: 3 }], links: [], unassigned: 0 }} labelOf={() => "Federated Learning + A Very Long Community Label Indeed"} colorOf={() => "#000"} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("Federated Learning + A Very Long Community Label Indeed")).toBeTruthy();
    expect(screen.getByText("Select the community for its members.")).toBeTruthy();
  });
});
