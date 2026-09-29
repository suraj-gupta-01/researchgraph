import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import InstitutionNetworkView from "./InstitutionNetworkView";
import TopInstitutions from "./TopInstitutions";

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));

function stub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return json(hit ? routes[hit] : {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const network = (over: Record<string, unknown> = {}) => ({
  center_id: null,
  min_shared: 1,
  total_candidates: 2,
  truncated: false,
  nodes: [
    { institution_id: 1, name: "Alpha University", country: "US", paper_count: 10, collaborators: 1, shared_papers: 3 },
    { institution_id: 2, name: "Beta Institute", country: "DE", paper_count: 6, collaborators: 1, shared_papers: 3 },
  ],
  edges: [{ source: 1, target: 2, shared_papers: 3 }],
  ...over,
});

describe("InstitutionNetworkView", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("draws the network and opens the selected institution from the URL", async () => {
    stub({ "/institutions/network": network() });
    render(
      <MemoryRouter initialEntries={["/institutions/network?sel=1"]}>
        <InstitutionNetworkView />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("group", { name: /2 institutions, 1 collaborating pairs/ })).toBeTruthy();
    const aside = screen.getByRole("complementary", { name: "Selected institution" });
    expect(aside.textContent).toContain("Alpha University");
    expect(aside.textContent).toContain("3 shared");
  });

  it("sends min_shared from the URL and reports the truncation", async () => {
    const fetchMock = stub({ "/institutions/network": network({ truncated: true, total_candidates: 40 }) });
    render(
      <MemoryRouter initialEntries={["/institutions/network?min=3"]}>
        <InstitutionNetworkView />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/most-collaborative of 40 institutions/)).toBeTruthy();
    expect(String(fetchMock.mock.calls[0][0])).toContain("min_shared=3");
  });

  it("names the command when no collaborations exist at all", async () => {
    stub({ "/institutions/network": network({ nodes: [], edges: [], total_candidates: 0 }) });
    render(
      <MemoryRouter initialEntries={["/institutions/network"]}>
        <InstitutionNetworkView />
      </MemoryRouter>,
    );
    expect(await screen.findByText("python -m ingestion.derive_collaboration")).toBeTruthy();
  });
});

describe("TopInstitutions", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  const institutions = {
    items: [
      { institution_id: 1, name: "Alpha University", country: "US", ror_id: null, paper_count: 10, author_count: 4 },
      { institution_id: 2, name: "Beta Institute", country: null, ror_id: null, paper_count: 6, author_count: 9 },
    ],
    total: 2,
    limit: 25,
    offset: 0,
  };
  const countries = {
    items: [
      { country: "US", institution_count: 1, paper_count: 10, author_count: 4 },
      { country: null, institution_count: 1, paper_count: 6, author_count: 9 },
    ],
    total_institutions: 2,
    total_papers: 14,
  };

  it("ranks by the server sort chosen in the URL and shows the country figure", async () => {
    const fetchMock = stub({ "/institutions/countries": countries, "/institutions?": institutions });
    render(
      <MemoryRouter initialEntries={["/institutions/top?by=authors"]}>
        <TopInstitutions />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "Alpha University" })).toBeTruthy();
    expect(await screen.findByText("Papers by country")).toBeTruthy();
    expect(screen.getByText(/14 papers with an institution attribution/)).toBeTruthy();
    const listCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/institutions?"));
    expect(listCall).toContain("sort=authors");
    expect(screen.getByRole("radio", { name: "By authors" }).getAttribute("aria-checked")).toBe("true");
  });

  it("points at the seed command on an empty database", async () => {
    stub({ "/institutions/countries": { items: [], total_institutions: 0, total_papers: 0 }, "/institutions?": { items: [], total: 0, limit: 25, offset: 0 } });
    render(
      <MemoryRouter initialEntries={["/institutions/top"]}>
        <TopInstitutions />
      </MemoryRouter>,
    );
    expect(await screen.findByText("python -m ingestion.seed_dev")).toBeTruthy();
  });
});
