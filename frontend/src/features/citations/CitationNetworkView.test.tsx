import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import CitationNetworkView from "./CitationNetworkView";

const network = {
  nodes: [
    { paper_id: 1, title: "Federated averaging for non-IID data", year: 2019, citation_count: 40, community_id: 3 },
    { paper_id: 2, title: "Communication-efficient federated learning", year: 2021, citation_count: 12, community_id: null },
  ],
  edges: [{ citing_id: 2, cited_id: 1 }],
  total_candidates: 2,
  truncated: false,
  query: "federated learning",
  search_meta: { mongo: "ok", matched_via: { title: 2, topic: 0, abstract: 0 }, truncated: false },
};

const paperDetail = {
  paper_id: 2,
  title: "Communication-efficient federated learning",
  doi: null,
  publication_year: 2021,
  citation_count: 12,
  venue: null,
  authors: [],
  sources: [],
  topics: [],
  cites_in_corpus: 1,
  cited_by_in_corpus: 0,
  abstract: "An abstract.",
  keywords: [],
  text_status: "ok",
};

function mockFetch() {
  return vi.fn((input: string | URL) => {
    const url = new URL(input);
    let body: unknown;
    if (url.pathname === "/search/citation-network") body = network;
    else if (url.pathname === "/papers/2") body = paperDetail;
    else if (url.pathname === "/papers/2/citation-chain") body = [];
    else body = { items: [], total: 0 };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
}

describe("CitationNetworkView", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the graph's papers as a legend and, in list view, a table", async () => {
    render(
      <MemoryRouter initialEntries={["/explore/network?q=federated+learning"]}>
        <CitationNetworkView />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/papers matching/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /view as list/i }));
    expect(await screen.findByText("Federated averaging for non-IID data")).toBeTruthy();
    expect(screen.getByText("Communication-efficient federated learning")).toBeTruthy();
  });

  it("opens the paper drawer and fetches the citation chain when a paper is selected", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/explore/network?q=federated+learning"]}>
        <CitationNetworkView />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole("button", { name: /view as list/i }));
    // click a non-link cell in that paper's row (the title cell is itself a
    // link to /papers/2 and would navigate instead of activating the row;
    // "12" -- its citation count -- is unique, unlike its year (2021 also
    // appears in the legend))
    await userEvent.click(await screen.findByText("12"));

    await waitFor(() => expect(screen.getByRole("link", { name: /open full page/i })).toBeTruthy());
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => new URL(c[0] as string).pathname === "/papers/2/citation-chain")).toBe(true));
  });

  it("does not show the not-yet-detected notice when at least one paper has a community", async () => {
    render(
      <MemoryRouter initialEntries={["/explore/network?q=federated+learning"]}>
        <CitationNetworkView />
      </MemoryRouter>,
    );
    const select = await screen.findByLabelText(/color by/i);
    await userEvent.selectOptions(select, "community");
    // node 1 has community_id 3, so this scope's communities have been detected
    expect(screen.queryByText(/communities have not been detected yet/i)).toBeNull();
  });
});
