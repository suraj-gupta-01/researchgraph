import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import InfluencePanel from "./InfluencePanel";

function stubInfluence(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))),
  );
}

const renderPanel = (authorId = 9) =>
  render(
    <MemoryRouter>
      <InfluencePanel authorId={authorId} />
    </MemoryRouter>,
  );

const influence = (overrides: Partial<Record<string, unknown>> = {}) => ({
  author_id: 9,
  full_name: "Dana Ortiz",
  degree_centrality: 0.182,
  betweenness_centrality: 0.041,
  pagerank: 0.021,
  bridge_score: 0.67,
  communities_touched: 3,
  algorithm: "participation_coefficient(louvain)",
  detection_date: "2026-08-01T00:00:00Z",
  ties: [
    { community_id: 1, label: "Federated Learning", weight: 4.2, share: 0.6 },
    { community_id: 2, label: "Privacy-Preserving ML", weight: 2.8, share: 0.4 },
  ],
  ...overrides,
});

describe("InfluencePanel", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("shows the three centralities, bridge score and ties once loaded", async () => {
    stubInfluence(influence());
    renderPanel();
    expect(await screen.findByText("Degree centrality")).toBeTruthy();
    expect(screen.getByText("Betweenness centrality")).toBeTruthy();
    expect(screen.getByText("PageRank")).toBeTruthy();
    expect(screen.getByText("Bridge score")).toBeTruthy();
    expect(screen.getByText(/Touches 3 communities/)).toBeTruthy();
    expect(screen.getAllByText("Federated Learning").length).toBeGreaterThan(0); // TieBar list item + table cell
    expect(screen.getAllByText("Privacy-Preserving ML").length).toBeGreaterThan(0);
    expect(screen.getByText("participation_coefficient(louvain)")).toBeTruthy(); // Method disclosure
  });

  it("names the run order when the author exists but hasn't been scored yet", async () => {
    stubInfluence({ detail: "No influence score for this author yet -- has graph.influence run?" }, 404);
    renderPanel();
    expect(await screen.findByText(/has not been computed yet/i)).toBeTruthy();
    expect(screen.getByText("python -m graph.influence")).toBeTruthy();
  });

  it("shows a not-found message for a plain author 404, distinct from the unscored case", async () => {
    stubInfluence({ detail: "Author not found" }, 404);
    renderPanel();
    expect(await screen.findByText(/could not be found/i)).toBeTruthy();
    expect(screen.queryByText(/has not been computed yet/i)).toBeNull();
  });

  it("flags communities_touched 0 with bridge_score 0 as untouched, not low-influence", async () => {
    stubInfluence(influence({ communities_touched: 0, bridge_score: 0, ties: [] }));
    renderPanel();
    expect(await screen.findByText(/no ties into any detected community/i)).toBeTruthy();
    expect(screen.getByText("No ties into a detected community.")).toBeTruthy();
  });

  it("labels a replaced community rather than a bare null", async () => {
    stubInfluence(influence({ ties: [{ community_id: 5, label: null, weight: 1.1, share: 1.0 }] }));
    renderPanel();
    expect(await screen.findAllByText("Replaced by a newer run")).toHaveLength(2); // TieBar list item + table cell
  });

  it("reports a network error with the docker-compose hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("fetch failed"))),
    );
    renderPanel();
    expect(await screen.findByText(/docker compose up -d/i)).toBeTruthy();
  });
});
