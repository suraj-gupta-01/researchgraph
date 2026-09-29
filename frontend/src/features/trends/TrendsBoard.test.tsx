import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import TrendsBoard from "./TrendsBoard";

const row = (topic_id: number, topic_name: string, paper_count: number, prior: number, growth_rate: number) => ({
  topic_id,
  topic_name,
  year: 2025,
  paper_count,
  prior_year_paper_count: prior,
  growth_rate,
  score: growth_rate,
  trend_label: "Emerging",
});
const page = (items: unknown[]) => ({ items, total: items.length, limit: 25, offset: 0 });

/** Routes fetches by path so each request gets the response its endpoint would give. */
function stubApi(handlers: { emerging?: unknown; declining?: unknown }) {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = new URL(String(input));
    let body: unknown = { detail: "unexpected" };
    let status = 404;
    if (url.pathname === "/topics/trending") {
      body = url.searchParams.get("direction") === "declining" ? (handlers.declining ?? page([])) : (handlers.emerging ?? page([]));
      status = 200;
    } else if (/^\/topics\/\d+\/trend$/.test(url.pathname)) {
      body = { topic_id: 1, topic_name: "x", algorithm: "growth_rate(em=0.3,dec=-0.3,min=3)", points: [] };
      status = 200;
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderBoard = (path = "/trends") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/trends" element={<TrendsBoard />} />
        <Route path="/topics/:id" element={<div>Topic page</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe("TrendsBoard", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("lists emerging topics with the year, growth and the rule read from the algorithm string", async () => {
    stubApi({ emerging: page([row(1, "Federated learning", 12, 6, 1.0), row(2, "Split learning", 5, 0, 2.0)]) });
    renderBoard();
    expect(await screen.findByText("Federated learning")).toBeTruthy();
    expect(screen.getByText("+100%")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy(); // Split learning has no prior year
    expect(screen.getByText(/latest period classified this way/i)).toBeTruthy();
    expect(await screen.findByText(/at least \+30% on the previous year, with at least 3 papers/i)).toBeTruthy();
  });

  it("asks the server for the other direction rather than filtering locally", async () => {
    const fetchMock = stubApi({ emerging: page([row(1, "Federated learning", 12, 6, 1.0)]), declining: page([]) });
    renderBoard();
    await screen.findByText("Federated learning");
    fetchMock.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Declining" }));
    await screen.findByRole("heading", { name: /declining topics/i });
    const called = fetchMock.mock.calls.map((c) => new URL(String(c[0])));
    expect(called.some((u) => u.pathname === "/topics/trending" && u.searchParams.get("direction") === "declining")).toBe(true);
  });

  it("names the command when neither direction has been computed", async () => {
    stubApi({ emerging: page([]), declining: page([]) });
    renderBoard();
    expect(await screen.findByText(/has not been computed yet/i)).toBeTruthy();
    expect(screen.getByText("python -m graph.trends")).toBeTruthy();
  });

  it("points to the other direction when only this one is empty", async () => {
    stubApi({ emerging: page([]), declining: page([{ ...row(3, "Legacy topic", 4, 9, -0.55), trend_label: "Declining" }]) });
    renderBoard();
    expect(await screen.findByText(/no topic is classified emerging in any period/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /show declining topics/i })).toBeTruthy();
  });

  it("says so when the chosen year has no topics, and offers the latest period", async () => {
    stubApi({ emerging: page([]) });
    renderBoard("/trends?year=1999");
    expect(await screen.findByText(/no topics were classified emerging in 1999/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /show the latest period/i })).toBeTruthy();
  });
});
