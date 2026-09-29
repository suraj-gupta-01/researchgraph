import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MethodsPage from "./MethodsPage";
import Home from "../home/Home";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function stub(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const hit = Object.keys(routes).find((k) => url.includes(k));
      return json(hit ? routes[hit] : {});
    }),
  );
}

const run = (analysis: string, over: Record<string, unknown> = {}) => ({
  analysis,
  status: "ok",
  source: "mongo",
  algorithm: null,
  detected_at: "2026-09-26T10:37:33Z",
  params: {},
  counts: {},
  details: {},
  postgres_rows: null,
  ...over,
});

const runs = (over: Record<string, Record<string, unknown>> = {}, extra: Record<string, unknown> = {}) => ({
  mongo: "ok",
  runs: ["graph", "communities", "trends", "convergence", "influence", "provenance"].map((a) => run(a, over[a])),
  provenance_checks: [
    { name: "doi_unique", status: "pass", detail: "no DOI is shared", count: 0 },
    { name: "orcid_format", status: "skipped", detail: "no ORCID column", count: null },
  ],
  ...extra,
});

describe("MethodsPage", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("shows each run's algorithm, parameters and counts", async () => {
    stub({
      "/meta/runs": runs({
        communities: { algorithm: "louvain(resolution=1,seed=42)", params: { resolution: 1, seed: 42 }, counts: { communities_kept: 4 }, postgres_rows: 4 },
      }),
    });
    render(<MemoryRouter><MethodsPage /></MemoryRouter>);
    const card = await screen.findByRole("complementary", { name: "Research communities: last run" });
    expect(within(card).getByText("louvain(resolution=1,seed=42)")).toBeTruthy();
    expect(within(card).getByText("resolution=1, seed=42")).toBeTruthy();
    expect(within(card).getByText("Communities kept")).toBeTruthy();
  });

  it("never counts a skipped provenance check as a pass", async () => {
    stub({ "/meta/runs": runs() });
    render(<MemoryRouter><MethodsPage /></MemoryRouter>);
    expect(await screen.findByText(/1 passed · 0 warnings · 0 failed · 1 skipped/)).toBeTruthy();
    expect(screen.getByText(/not a pass/)).toBeTruthy();
  });

  it("names the command and run order for an analysis that has not run", async () => {
    stub({ "/meta/runs": runs({ influence: { status: "not_run", source: null, detected_at: null } }) });
    render(<MemoryRouter><MethodsPage /></MemoryRouter>);
    const card = await screen.findByRole("complementary", { name: "Researcher influence and bridges: last run" });
    expect(within(card).getByText("Not run yet")).toBeTruthy();
    expect(within(card).getByText("python -m graph.influence")).toBeTruthy();
    expect(within(card).getByText(/After graph.communities/)).toBeTruthy();
  });

  it("flags a summary from another run and a missing summary", async () => {
    stub({
      "/meta/runs": runs({
        trends: { status: "mismatch", algorithm: "growth_rate(em=0.3,dec=-0.3,min=3)" },
        convergence: { status: "postgres_only", source: "postgres" },
      }),
    });
    render(<MemoryRouter><MethodsPage /></MemoryRouter>);
    expect(await screen.findByText("Summary from another run")).toBeTruthy();
    expect(screen.getByText("Summary missing")).toBeTruthy();
  });

  it("reports a MongoDB outage once, at the top", async () => {
    stub({ "/meta/runs": runs({}, { mongo: "unavailable", provenance_checks: [] }) });
    render(<MemoryRouter><MethodsPage /></MemoryRouter>);
    expect(await screen.findByText(/MongoDB is unavailable/)).toBeTruthy();
  });
});

describe("Home", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  const empty = { items: [], total: 0, limit: 5, offset: 0 };

  it("shows a digest per analysis, and 'Not computed yet' where a job has not run", async () => {
    stub({
      "/meta/runs": runs({ graph: { details: { full_graph: { node_counts: { paper: 140, author: 48, institution: 12, venue: 5, topic: 226 } } } } }),
      "/topics/trending": {
        items: [{ topic_id: 7, topic_name: "Differential privacy", year: 2025, paper_count: 9, prior_year_paper_count: 4, growth_rate: 1.25, score: 1.25, trend_label: "Emerging" }],
        total: 1, limit: 5, offset: 0,
      },
      "/topics/converging": empty,
      "/authors/bridges": { ...empty, algorithm: null },
      "/communities": { ...empty, query: null, search_meta: null },
    });
    render(<MemoryRouter><Home /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: "Differential privacy" })).toBeTruthy();
    expect(screen.getByText("+125%")).toBeTruthy();
    expect(await screen.findByText("python -m graph.convergence")).toBeTruthy();
    expect(screen.getByText("python -m graph.influence")).toBeTruthy();
    expect(screen.getByText("python -m graph.communities")).toBeTruthy();
    expect(screen.getByText(/140 papers · 48 authors/)).toBeTruthy();
  });
});
