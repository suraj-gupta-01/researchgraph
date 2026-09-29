import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ScopeProvider } from "../../app/ScopeContext";
import Explore from "./Explore";

const overview = {
  query: "federated learning",
  summary: { papers: 2, authors: 3, institutions: 2, citation_edges: 1, year_min: 2020, year_max: 2021 },
  year_histogram: [
    { year: 2020, paper_count: 1 },
    { year: 2021, paper_count: 1 },
  ],
  top_authors: [{ author_id: 1, full_name: "A. Lee", paper_count: 2, total_citations: 40 }],
  top_institutions: [],
  top_venues: [],
  topics: [],
  keywords: [],
  meta: { mongo: "unavailable", matched_via: { title: 2, topic: 0, abstract: 0 }, truncated: false },
};

const papersPage = {
  items: [
    { paper_id: 10, title: "Federated averaging for non-IID data", doi: null, publication_year: 2020, citation_count: 12, venue_id: null, venue_name: "NeurIPS", authors: ["A. Lee"], author_count: 1, relevance: 3 },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

const paperDetail = {
  paper_id: 10,
  title: "Federated averaging for non-IID data",
  doi: null,
  publication_year: 2020,
  citation_count: 12,
  venue: { venue_id: 1, venue_name: "NeurIPS", venue_type: "conference" },
  authors: [{ author_id: 1, full_name: "A. Lee", orcid: null, position: 1, institutions: [] }],
  sources: [],
  topics: [],
  cites_in_corpus: 0,
  cited_by_in_corpus: 0,
  abstract: "An abstract about federated averaging.",
  keywords: ["federated learning"],
  text_status: "ok",
};

function mockFetch() {
  return vi.fn((input: string | URL) => {
    const url = new URL(input);
    let body: unknown;
    if (url.pathname === "/search/overview") body = overview;
    else if (url.pathname === "/search/papers") body = papersPage;
    else if (/^\/papers\/\d+$/.test(url.pathname)) body = paperDetail;
    else body = { items: [], total: 0 };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
}

describe("Explore", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the overview summary, a degraded-mongo notice, and the ranked result list", async () => {
    render(
      <MemoryRouter initialEntries={["/explore?q=federated+learning"]}>
        <ScopeProvider>
          <Explore />
        </ScopeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/2 papers on/i)).toBeTruthy();
    expect(screen.getByText(/titles and topic tags only/i)).toBeTruthy();
    expect(await screen.findByText("Federated averaging for non-IID data")).toBeTruthy();
  });

  it("opens the paper peek drawer with an 'Open full page' link when a result is selected", async () => {
    render(
      <MemoryRouter initialEntries={["/explore?q=federated+learning"]}>
        <ScopeProvider>
          <Explore />
        </ScopeProvider>
      </MemoryRouter>,
    );

    const resultButton = await screen.findByText("Federated averaging for non-IID data");
    await userEvent.click(resultButton);

    await waitFor(() => expect(screen.getByRole("link", { name: /open full page/i })).toBeTruthy());
  });

  it("shows the empty-topic landing with example chips when there is no scope", () => {
    render(
      <MemoryRouter initialEntries={["/explore"]}>
        <ScopeProvider>
          <Explore />
        </ScopeProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/explore a research topic/i)).toBeTruthy();
  });
});
