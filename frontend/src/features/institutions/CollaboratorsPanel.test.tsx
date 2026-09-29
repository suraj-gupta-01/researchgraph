import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CollaboratorsPanel from "./CollaboratorsPanel";

/** Routes the two requests the panel makes to their own canned bodies. */
function stub(collaborators: unknown, network: unknown) {
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    return url.includes("/institutions/network") ? json(network) : json(collaborators);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderPanel = () =>
  render(
    <MemoryRouter>
      <CollaboratorsPanel institutionId={1} name="Alpha University" />
    </MemoryRouter>,
  );

const network = {
  center_id: 1,
  min_shared: 1,
  total_candidates: 3,
  truncated: false,
  nodes: [
    { institution_id: 1, name: "Alpha University", country: "US", paper_count: 10, collaborators: 2, shared_papers: 5 },
    { institution_id: 2, name: "Beta Institute", country: "DE", paper_count: 6, collaborators: 2, shared_papers: 4 },
    { institution_id: 3, name: "Gamma College", country: null, paper_count: 2, collaborators: 2, shared_papers: 3 },
  ],
  edges: [
    { source: 1, target: 2, shared_papers: 3 },
    { source: 1, target: 3, shared_papers: 2 },
    { source: 2, target: 3, shared_papers: 1 },
  ],
};

describe("CollaboratorsPanel", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("lists collaborators and draws the ego network from one network request", async () => {
    const fetchMock = stub(
      {
        items: [
          { institution_id: 2, name: "Beta Institute", country: "DE", shared_papers: 3 },
          { institution_id: 3, name: "Gamma College", country: null, shared_papers: 2 },
        ],
        total: 2,
        limit: 10,
        offset: 0,
      },
      network,
    );
    renderPanel();
    expect(await screen.findByRole("link", { name: "Beta Institute" })).toBeTruthy();
    expect(await screen.findByRole("group", { name: /Institution collaboration matrix: 3 institutions, 3 collaborating pairs/ })).toBeTruthy();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("/institutions/network"))).toHaveLength(1);
    expect(urls.some((u) => u.includes("center_id=1"))).toBe(true);
    // country legend, with the unknown bucket kept grey and named
    expect(screen.getByText("Unknown country")).toBeTruthy();
  });

  it("explains an institution with no collaborations instead of drawing an empty graph", async () => {
    stub({ items: [], total: 0, limit: 10, offset: 0 }, { ...network, nodes: [network.nodes[0]], edges: [], total_candidates: 1 });
    renderPanel();
    expect(await screen.findByText(/No shared papers with another institution/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Institution collaboration network/ })).toBeNull();
  });
});
