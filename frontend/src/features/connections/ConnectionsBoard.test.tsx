import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ConnectionsBoard from "./ConnectionsBoard";

const pair = (topic_a_id: number, topic_a_name: string, topic_b_id: number, topic_b_name: string, cooccurrence_count: number, prior_cooccurrence_count: number, growth_rate: number) => ({
  topic_a_id,
  topic_a_name,
  topic_b_id,
  topic_b_name,
  year: 2025,
  cooccurrence_count,
  prior_cooccurrence_count,
  growth_rate,
  convergence_score: growth_rate,
});
const page = (items: unknown[]) => ({ items, total: items.length, limit: 25, offset: 0 });

const pairTrend = (overrides: Partial<Record<string, unknown>> = {}) => ({
  topic_a_id: 1,
  topic_a_name: "Privacy",
  topic_b_id: 2,
  topic_b_name: "Healthcare",
  algorithm: "growth_rate(em=0.3,dec=-0.3,min=3)",
  points: [{ year: 2025, cooccurrence_count: 14, prior_cooccurrence_count: 6, growth_rate: 1.0, is_converging: true }],
  ...overrides,
});

function stubApi(handlers: { converging?: unknown; trend?: unknown; runs?: unknown }) {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = new URL(String(input));
    let body: unknown = { detail: "unexpected" };
    let status = 404;
    if (url.pathname === "/topics/converging") {
      body = handlers.converging ?? page([]);
      status = 200;
    } else if (/^\/topics\/pairs\/\d+\/\d+\/trend$/.test(url.pathname)) {
      body = handlers.trend ?? pairTrend();
      status = 200;
    } else if (url.pathname === "/meta/runs" && handlers.runs) {
      body = handlers.runs;
      status = 200;
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderBoard = (path = "/connections") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/connections" element={<ConnectionsBoard />} />
      </Routes>
    </MemoryRouter>,
  );

// Topic names now also appear in the matrix (SVG labels and its sr-only table
// view), so row-level assertions are scoped to the ranked table.
const rankedTable = () => screen.getByRole("table", { name: /^Converging topic pairs/ });

// "Machine learning" is in 3 of these 4 pairs, so it is the page's most frequent topic.
const REPEATED = [
  pair(1, "Machine learning", 2, "Healthcare", 14, 6, 1.0),
  pair(1, "Machine learning", 3, "Privacy", 9, 4, 1.25),
  pair(4, "Graph theory", 5, "Chemistry", 5, 0, 2.0),
  pair(1, "Machine learning", 6, "Robotics", 7, 5, 0.4),
];

describe("ConnectionsBoard", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("lists converging pairs with both topics, growth, and the Converging badge", async () => {
    stubApi({ converging: page([pair(1, "Privacy", 2, "Healthcare", 14, 6, 1.0), pair(3, "Federated learning", 4, "Split learning", 5, 0, 2.0)]) });
    renderBoard();
    await screen.findByRole("table", { name: /^Converging topic pairs/ });
    const table = within(rankedTable());
    expect(table.getByText("Privacy")).toBeTruthy();
    expect(table.getByText("Healthcare")).toBeTruthy();
    expect(table.getByText("+100%")).toBeTruthy();
    expect(table.getByText("New")).toBeTruthy(); // second pair has no prior co-occurrence
    expect(table.getAllByText("Converging").length).toBeGreaterThan(0);
    expect(screen.getByText(/latest period with any converging pairs/i)).toBeTruthy();
  });

  it("names the command when nothing has ever converged", async () => {
    stubApi({ converging: page([]) });
    renderBoard();
    expect(await screen.findByText(/has not been computed yet/i)).toBeTruthy();
    expect(screen.getByText("python -m graph.convergence")).toBeTruthy();
  });

  it("says so when the chosen year has no converging pairs, and offers the latest period", async () => {
    stubApi({ converging: page([]) });
    renderBoard("/connections?year=1999");
    expect(await screen.findByText(/no topic pairs converged in 1999/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /show the latest period/i })).toBeTruthy();
  });

  it("moves to the previous year and requests it", async () => {
    const fetchMock = stubApi({ converging: page([pair(1, "Privacy", 2, "Healthcare", 14, 6, 1.0)]) });
    renderBoard("/connections?year=2025");
    await screen.findByRole("table", { name: /^Converging topic pairs/ });
    fetchMock.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Previous year" }));
    const called = fetchMock.mock.calls.map((c) => new URL(String(c[0])));
    expect(called.some((u) => u.pathname === "/topics/converging" && u.searchParams.get("year") === "2024")).toBe(true);
  });

  it("opens a pair's co-occurrence trajectory in a drawer on row activation", async () => {
    stubApi({ converging: page([pair(1, "Privacy", 2, "Healthcare", 14, 6, 1.0)]) });
    renderBoard();
    await screen.findByRole("table", { name: /^Converging topic pairs/ });
    await userEvent.click(within(rankedTable()).getByText("Privacy").closest("tr")!);
    // "Co-occurrence trajectory" is PairTrendPanel's own figure title, not
    // used by the board's table or the matrix, so it uniquely confirms the
    // drawer's PairTrendPanel actually loaded.
    expect(await screen.findByText("Co-occurrence trajectory")).toBeTruthy();
  });

  describe("Phase 6c", () => {
    it("offers to hide the page's most frequent topic, naming it and how often it appears", async () => {
      stubApi({ converging: page(REPEATED) });
      renderBoard();
      const box = await screen.findByRole("checkbox", { name: /hide pairs containing .Machine learning. \(in 3 of 4 pairs on this page\)/i });
      expect((box as HTMLInputElement).checked).toBe(false);
      expect(screen.getByText(/does not query the server again/i)).toBeTruthy();
    });

    it("does not offer the filter when no topic appears in more than one pair", async () => {
      stubApi({ converging: page([pair(1, "Privacy", 2, "Healthcare", 14, 6, 1.0), pair(3, "Graph theory", 4, "Chemistry", 5, 0, 2.0)]) });
      renderBoard();
      await screen.findByRole("table", { name: /^Converging topic pairs/ });
      expect(screen.queryByRole("checkbox")).toBeNull();
    });

    it("hides those pairs client-side, keeps the server's rank numbers, and makes no new request", async () => {
      const fetchMock = stubApi({ converging: page(REPEATED) });
      renderBoard();
      const box = await screen.findByRole("checkbox", { name: /hide pairs containing/i });
      const calls = fetchMock.mock.calls.length;
      await userEvent.click(box);

      const table = within(rankedTable());
      expect(table.queryByText("Machine learning")).toBeNull();
      expect(table.getByText("Graph theory")).toBeTruthy();
      const row = table.getByText("Graph theory").closest("tr")!;
      expect(within(row).getAllByRole("cell")[0].textContent).toBe("3"); // server rank, not position 1
      expect(screen.getByText(/hiding 3 of 4 pairs on this page/i)).toBeTruthy();
      expect(fetchMock.mock.calls.length).toBe(calls);
    });

    it("restores every pair when the filter is turned off again", async () => {
      stubApi({ converging: page(REPEATED) });
      renderBoard();
      const box = await screen.findByRole("checkbox", { name: /hide pairs containing/i });
      await userEvent.click(box);
      await userEvent.click(screen.getByRole("checkbox", { name: /hide pairs containing/i }));
      expect(within(rankedTable()).getAllByText("Machine learning")).toHaveLength(3);
    });

    it("reproduces a hidden topic from the URL and says so when it empties the page", async () => {
      stubApi({ converging: page(REPEATED.filter((p) => p.topic_a_id === 1)) });
      renderBoard("/connections?hideTopic=1&hideTopicName=Machine%20learning");
      expect(await screen.findByText(/every pair on this page contains/i)).toBeTruthy();
      expect(screen.queryByRole("table", { name: /^Converging topic pairs/ })).toBeNull();
      const box = screen.getByRole("checkbox", { name: /hide pairs containing .Machine learning./i }) as HTMLInputElement;
      expect(box.checked).toBe(true);
      await userEvent.click(box);
      expect(await screen.findByRole("table", { name: /^Converging topic pairs/ })).toBeTruthy();
    });

    it("shows the convergence run's algorithm and date from /meta/runs in Method", async () => {
      stubApi({
        converging: page(REPEATED),
        runs: {
          mongo: "ok",
          provenance_checks: [],
          runs: [
            { analysis: "trends", status: "ok", source: "mongo", algorithm: "growth_rate(em=0.3,dec=-0.3,min=3)", detected_at: "2026-01-02T00:00:00Z", params: {}, counts: {}, details: {}, postgres_rows: null },
            { analysis: "convergence", status: "ok", source: "mongo", algorithm: "cooccurrence_growth(conv=0.3,min=3)", detected_at: "2026-01-02T00:00:00Z", params: {}, counts: {}, details: {}, postgres_rows: null },
          ],
        },
      });
      renderBoard();
      await screen.findByRole("table", { name: /^Converging topic pairs/ });
      expect((await screen.findAllByText("cooccurrence_growth(conv=0.3,min=3)")).length).toBeGreaterThan(0);
      expect(screen.queryByText(/not reported with this list/i)).toBeNull();
      expect(screen.getAllByText(/Run date:/).length).toBeGreaterThan(0);
    });

    it("falls back to a note when /meta/runs cannot supply the algorithm, without claiming the analysis has not run", async () => {
      stubApi({ converging: page(REPEATED) });
      renderBoard();
      await screen.findByRole("table", { name: /^Converging topic pairs/ });
      expect(screen.getAllByText(/not reported with this list/i).length).toBeGreaterThan(0);
      expect(screen.queryByText(/not run yet/i)).toBeNull();
    });

    it("carries the previously-separate limitation in Method", async () => {
      stubApi({ converging: page(REPEATED) });
      renderBoard();
      await screen.findByRole("table", { name: /^Converging topic pairs/ });
      expect(screen.getAllByText(/not when the two topics were previously separate/i).length).toBeGreaterThan(0);
    });

    it("draws the matrix with one focusable cell per pair, and a cell opens the pair drawer", async () => {
      stubApi({ converging: page(REPEATED) });
      renderBoard();
      expect(await screen.findByText("Converging pairs as a matrix")).toBeTruthy();
      const cells = screen.getAllByRole("button", { name: /convergence score/i });
      expect(cells).toHaveLength(REPEATED.length);
      await userEvent.click(cells[0]);
      expect(await screen.findByText("Co-occurrence trajectory")).toBeTruthy();
    });

    it("drops the hidden topic from the matrix as well", async () => {
      stubApi({ converging: page(REPEATED) });
      renderBoard();
      await userEvent.click(await screen.findByRole("checkbox", { name: /hide pairs containing/i }));
      expect(screen.getAllByRole("button", { name: /convergence score/i })).toHaveLength(1);
      expect(screen.getByText(/pairs containing .Machine learning. are hidden/i)).toBeTruthy();
    });
  });
});
