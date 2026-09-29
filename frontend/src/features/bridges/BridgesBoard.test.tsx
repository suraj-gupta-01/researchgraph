import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import BridgesBoard from "./BridgesBoard";

const author = (overrides: Partial<Record<string, unknown>> = {}) => ({
  author_id: 9,
  full_name: "Dana Ortiz",
  paper_count: 14,
  degree_centrality: 0.18,
  betweenness_centrality: 0.041,
  pagerank: 0.021,
  bridge_score: 0.67,
  communities_touched: 3,
  ties: [{ community_id: 1, label: "Federated Learning", weight: 4.2, share: 0.6 }],
  ...overrides,
});

const bridgePage = (items: unknown[], overrides: Partial<Record<string, unknown>> = {}) => ({
  items,
  total: items.length,
  limit: 25,
  offset: 0,
  query: null,
  search_meta: null,
  algorithm: "participation_coefficient(louvain)",
  ...overrides,
});

const influence = (overrides: Partial<Record<string, unknown>> = {}) => ({
  author_id: 9,
  full_name: "Dana Ortiz",
  degree_centrality: 0.18,
  betweenness_centrality: 0.041,
  pagerank: 0.021,
  bridge_score: 0.67,
  communities_touched: 3,
  algorithm: "participation_coefficient(louvain)",
  detection_date: "2026-08-01T00:00:00Z",
  ties: [{ community_id: 1, label: "Federated Learning", weight: 4.2, share: 0.6 }],
  ...overrides,
});

function stubApi(handlers: { bridges?: unknown; influence?: unknown }) {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = new URL(String(input));
    let body: unknown = { detail: "unexpected" };
    let status = 404;
    if (url.pathname === "/authors/bridges") {
      body = handlers.bridges ?? bridgePage([]);
      status = 200;
    } else if (/^\/authors\/\d+\/influence$/.test(url.pathname)) {
      body = handlers.influence ?? influence();
      status = 200;
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderBoard = (path = "/bridges") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/bridges" element={<BridgesBoard />} />
      </Routes>
    </MemoryRouter>,
  );

describe("BridgesBoard", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("lists researchers with bridge score, betweenness, communities touched, and the tie-profile figure", async () => {
    stubApi({ bridges: bridgePage([author()]) });
    renderBoard();
    expect(await screen.findAllByText("Dana Ortiz")).not.toHaveLength(0);
    expect(screen.getAllByText("0.67").length).toBeGreaterThan(0); // bridge score, table cell (also in the figure and its table view)
    expect(screen.getByText(/every researcher touching at least 2/i)).toBeTruthy();
    // the main community column: one chip, the community and its share
    expect(screen.getByText("Most ties go to")).toBeTruthy();
    expect(screen.getByText("· 60%")).toBeTruthy();
    // the comparison chart is opt-in
    expect(screen.queryByText("Where each researcher's ties go")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Compare tie profiles" }));
    expect(screen.getByText("Where each researcher's ties go")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^1\. Dana Ortiz, bridge score 0\.67: 60% Federated Learning/ })).toBeTruthy();
    expect(screen.getByText("0.041")).toBeTruthy(); // betweenness column
    expect(screen.getByText("participation_coefficient(louvain)")).toBeTruthy(); // Method
  });

  it("shows matched communities and scoped copy when the top-bar scope is set", async () => {
    stubApi({ bridges: bridgePage([author({ matched_communities: 2 })]) });
    renderBoard("/bridges?q=federated+learning");
    await screen.findAllByText("Dana Ortiz");
    expect(screen.getByText("Matched communities")).toBeTruthy();
    expect(screen.getAllByText(/matching\s*\u201cfederated learning\u201d/i).length).toBeGreaterThan(0);
  });

  it("names the command when the analysis has never run", async () => {
    stubApi({ bridges: bridgePage([], { algorithm: null }) });
    renderBoard();
    expect(await screen.findByText(/has not been computed yet/i)).toBeTruthy();
    expect(screen.getByText("python -m graph.influence")).toBeTruthy();
  });

  it("distinguishes an empty filter result from a never-run analysis", async () => {
    stubApi({ bridges: bridgePage([]) }); // algorithm present, total 0
    renderBoard();
    expect(await screen.findByText(/no researcher touches at least 2 communities/i)).toBeTruthy();
    expect(screen.queryByText(/has not been computed yet/i)).toBeNull();
    expect(screen.getByRole("button", { name: /try a minimum of 1/i })).toBeTruthy();
  });

  it("requests the new min_communities value when the control is submitted", async () => {
    const fetchMock = stubApi({ bridges: bridgePage([author()]) });
    renderBoard();
    await screen.findAllByText("Dana Ortiz");
    fetchMock.mockClear();
    const input = screen.getByLabelText(/minimum communities bridged/i);
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    const called = fetchMock.mock.calls.map((c) => new URL(String(c[0])));
    expect(called.some((u) => u.pathname === "/authors/bridges" && u.searchParams.get("min_communities") === "5")).toBe(true);
  });

  it("opens the researcher's tie evidence in a drawer on row activation", async () => {
    stubApi({ bridges: bridgePage([author()]), influence: influence() });
    renderBoard();
    const rows = await screen.findAllByText("Dana Ortiz");
    await userEvent.click(rows[rows.length - 1].closest("tr")!);
    // "Touches N communities" is InfluencePanel's own phrasing, not used by
    // the board's table or scatter, so it uniquely confirms the drawer's
    // InfluencePanel actually loaded (a plain "Bridge score" match is
    // ambiguous: it's also a table header and a scatter-table column label).
    expect(await screen.findByText(/Touches 3 communities/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /open full page/i })).toBeTruthy();
  });
});
