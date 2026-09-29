import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PairTrendPanel from "./PairTrendPanel";

function stubTrend(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))),
  );
}

const renderPanel = (props: Partial<Parameters<typeof PairTrendPanel>[0]> = {}) =>
  render(
    <MemoryRouter>
      <PairTrendPanel topicAId={1} topicAName="Privacy" topicBId={2} topicBName="Healthcare" {...props} />
    </MemoryRouter>,
  );

const trend = (overrides: Partial<Record<string, unknown>> = {}) => ({
  topic_a_id: 1,
  topic_a_name: "Privacy",
  topic_b_id: 2,
  topic_b_name: "Healthcare",
  algorithm: "growth_rate(em=0.3,dec=-0.3,min=3)",
  points: [
    { year: 2022, cooccurrence_count: 4, prior_cooccurrence_count: 0, growth_rate: 2.0, is_converging: false },
    { year: 2023, cooccurrence_count: 9, prior_cooccurrence_count: 4, growth_rate: 1.25, is_converging: true },
  ],
  ...overrides,
});

describe("PairTrendPanel", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("shows the yearly counts, growth, and the Converging badge once loaded", async () => {
    stubTrend(trend());
    renderPanel();
    expect(await screen.findByText("Co-occurrence trajectory")).toBeTruthy();
    expect(screen.getByText(/Privacy \+ Healthcare, 2022 to 2023/)).toBeTruthy();
    expect(screen.getByText("growth_rate(em=0.3,dec=-0.3,min=3)")).toBeTruthy(); // Method disclosure
    expect(screen.getAllByText("Converging").length).toBeGreaterThan(0);
  });

  it("names the run order when the pair exists but has no trend rows yet", async () => {
    stubTrend(trend({ algorithm: null, points: [] }));
    renderPanel();
    expect(await screen.findByText(/has not been computed yet/i)).toBeTruthy();
    expect(screen.getByText("python -m graph.convergence")).toBeTruthy();
  });

  it("shows a not-found message for a missing topic", async () => {
    stubTrend({ detail: "Topic not found" }, 404);
    renderPanel();
    expect(await screen.findByText(/could not be found/i)).toBeTruthy();
  });

  it("names the self-pair rule for a 422", async () => {
    stubTrend({ detail: "A topic cannot be paired with itself" }, 422);
    renderPanel({ topicBId: 1, topicBName: "Privacy" });
    expect(await screen.findByText(/cannot be paired with itself/i)).toBeTruthy();
  });
});
