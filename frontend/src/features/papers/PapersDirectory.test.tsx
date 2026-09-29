import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import PapersDirectory from "./PapersDirectory";

const page1 = {
  items: [{ paper_id: 1, title: "Alpha paper", doi: null, publication_year: 2021, citation_count: 5, venue_id: null, venue_name: "NeurIPS", authors: ["A. Lee"], author_count: 1 }],
  total: 1,
  limit: 25,
  offset: 0,
};

function mockFetch() {
  return vi.fn((_input: string | URL) => Promise.resolve(new Response(JSON.stringify(page1), { status: 200, headers: { "Content-Type": "application/json" } })));
}

describe("PapersDirectory", () => {
  beforeEach(() => vi.stubGlobal("fetch", mockFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it("renders the paper list from GET /papers", async () => {
    render(
      <MemoryRouter initialEntries={["/papers"]}>
        <Routes>
          <Route path="/papers" element={<PapersDirectory />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Alpha paper")).toBeTruthy();
    expect(screen.getByText("1 papers")).toBeTruthy();
  });

  it("requests the server for a new sort rather than re-ordering locally", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/papers"]}>
        <Routes>
          <Route path="/papers" element={<PapersDirectory />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Alpha paper");
    fetchMock.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /^year/i }));
    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("sort")).toBe("year");
  });

  it("navigates to the full paper page when a row is activated", async () => {
    render(
      <MemoryRouter initialEntries={["/papers"]}>
        <Routes>
          <Route path="/papers" element={<PapersDirectory />} />
          <Route path="/papers/:id" element={<div>Paper page for 1</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: "Alpha paper" });
    await userEvent.click(link);
    expect(await screen.findByText("Paper page for 1")).toBeTruthy();
  });
});
