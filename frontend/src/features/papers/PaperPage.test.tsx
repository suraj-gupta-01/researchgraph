import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import PaperPage from "./PaperPage";

const detail = {
  paper_id: 10,
  title: "Federated averaging for non-IID data",
  doi: "10.1000/example",
  publication_year: 2020,
  citation_count: 42,
  venue: { venue_id: 1, venue_name: "NeurIPS", venue_type: "conference" },
  authors: [
    { author_id: 1, full_name: "A. Lee", orcid: "0000-0001-2345-6789", position: 1, institutions: [{ institution_id: 5, name: "Example University", country: "Canada" }] },
  ],
  sources: [{ source_name: "openalex", source_record_id: "W123", source_citation_count: 40, fetched_at: "2026-01-01T00:00:00Z" }],
  topics: [{ topic_id: 7, topic_name: "Federated learning", relevance_score: 0.9, extraction_method: "tfidf" }],
  cites_in_corpus: 3,
  cited_by_in_corpus: 5,
  abstract: "An abstract about federated averaging.",
  keywords: ["federated learning", "privacy"],
  text_status: "ok",
};

const citationsPage = {
  items: [{ paper_id: 20, title: "A citing paper", doi: null, publication_year: 2021, citation_count: 3, venue_id: null, venue_name: null, authors: ["B. Scholar"], author_count: 1 }],
  total: 1,
  limit: 15,
  offset: 0,
};

const chainNodes = [{ paper_id: 21, title: "A chained paper", publication_year: 2021, citation_count: 3, depth: 1, parent_paper_id: 10 }];

function mockFetch() {
  return vi.fn((input: string | URL) => {
    const url = new URL(input);
    let body: unknown;
    if (/^\/papers\/10$/.test(url.pathname)) body = detail;
    else if (/citation-chain$/.test(url.pathname)) body = chainNodes;
    else if (/\/citations$/.test(url.pathname)) body = citationsPage;
    else body = { items: [], total: 0 };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/papers/10"]}>
      <Routes>
        <Route path="/papers/:id" element={<PaperPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PaperPage", () => {
  beforeEach(() => vi.stubGlobal("fetch", mockFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it("renders title, authors, venue and the abstract", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Federated averaging for non-IID data" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "A. Lee" })).toBeTruthy();
    expect(screen.getByText(/An abstract about federated averaging/)).toBeTruthy();
  });

  it("renders the provenance table with the source's record id and reported citation count", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Federated averaging for non-IID data" });
    const record = screen.getByRole("link", { name: /^W123/ });
    expect(record.getAttribute("href")).toBe("https://openalex.org/W123");
    expect(record.getAttribute("target")).toBe("_blank");
    expect(record.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("openalex")).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();
  });

  it("renders the cited-by panel from GET /papers/:id/citations", async () => {
    renderPage();
    expect(await screen.findByText("A citing paper")).toBeTruthy();
  });

  it("renders the citation-chain tree from GET /papers/:id/citation-chain", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Federated averaging for non-IID data" });
    expect(await screen.findByText(/2021, cited 3 times/)).toBeTruthy();  });

  it("shows a 404 page for a paper that does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ detail: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } }))),
    );
    renderPage();
    expect(await screen.findByText(/could not be found/i)).toBeTruthy();
  });
});
