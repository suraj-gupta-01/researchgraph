import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TopicTrendPanel from "./TopicTrendPanel";

const point = (year: number, paper_count: number, growth_rate: number | null, trend_label: string | null) => ({
  year,
  paper_count,
  author_count: paper_count,
  institution_count: 2,
  citation_count: 10,
  growth_rate,
  trend_label,
  score: growth_rate,
});

function stubTrend(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))),
  );
}

const renderPanel = () =>
  render(
    <MemoryRouter>
      <TopicTrendPanel topicId={7} />
    </MemoryRouter>,
  );

describe("TopicTrendPanel", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("names the command and the run order when there are no points", async () => {
    stubTrend({ topic_id: 7, topic_name: "Federated learning", algorithm: null, points: [] });
    renderPanel();
    expect(await screen.findByText(/has not been computed yet/i)).toBeTruthy();
    expect(screen.getByText("python -m graph.trends")).toBeTruthy();
  });

  it("draws a dormant year as a gap and reads the thresholds from the algorithm string", async () => {
    stubTrend({
      topic_id: 7,
      topic_name: "Federated learning",
      algorithm: "growth_rate(em=0.3,dec=-0.3,min=3)",
      points: [point(2021, 4, 2.0, "Stable"), point(2023, 9, 2.0, "Emerging")],
    });
    renderPanel();
    expect(await screen.findByText("Emerging threshold +30%")).toBeTruthy();
    expect(screen.getByText("Declining threshold -30%")).toBeTruthy();
    expect(screen.getByText("No papers tagged")).toBeTruthy(); // the 2022 row of the table view
    expect(screen.getByLabelText("2022: no papers tagged")).toBeTruthy(); // the focusable column
    expect(screen.getByText("growth_rate(em=0.3,dec=-0.3,min=3)")).toBeTruthy(); // Method disclosure
  });

  it("shows 2.0 as new only without a prior year, and as +200% with one", async () => {
    stubTrend({
      topic_id: 7,
      topic_name: "Federated learning",
      algorithm: "growth_rate(em=0.3,dec=-0.3,min=3)",
      points: [point(2021, 3, 2.0, "Stable"), point(2022, 9, 2.0, "Emerging")],
    });
    renderPanel();
    expect(await screen.findByLabelText("2021: 3 papers, new, no papers the year before, Stable")).toBeTruthy();
    expect(screen.getByLabelText("2022: 9 papers, +200% on the year before, Emerging")).toBeTruthy();
  });

  it("says labels are not computed when snapshots exist but graph.trends has not run", async () => {
    stubTrend({ topic_id: 7, topic_name: "Federated learning", algorithm: null, points: [point(2021, 4, null, null), point(2022, 5, null, null)] });
    renderPanel();
    expect(await screen.findByText(/have not been computed/i)).toBeTruthy();
  });

  it("shows a not-found message on 404", async () => {
    stubTrend({ detail: "Topic not found" }, 404);
    renderPanel();
    expect(await screen.findByText(/could not be found/i)).toBeTruthy();
  });
});
