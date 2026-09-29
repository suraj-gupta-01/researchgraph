import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import QueryLab from "./QueryLab";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

const catalog = [
  {
    key: "topic-authors",
    title: "Authors on a topic in a year range, with institutions",
    prd_text: "Find all authors who published on Federated Learning between 2023-2025, with their institutions.",
    kind: "stored function + joins",
    endpoint: "GET /queries/topic-authors",
    statement: "SELECT author_id FROM fn_topic_authors(:topic_id, :year_from, :year_to, :min_relevance)",
    objects: [{ kind: "function", name: "fn_topic_authors", definition: "CREATE OR REPLACE FUNCTION public.fn_topic_authors(...)" }],
  },
  {
    key: "cross-community-citations",
    title: "Papers citing papers from a different research community",
    prd_text: "Find papers that cite papers from a different research community.",
    kind: "views + joins",
    endpoint: "GET /queries/cross-community-citations",
    statement: "SELECT * FROM v_cross_community_citation",
    objects: [],
  },
];

function stub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return json(hit ? routes[hit] : { items: [], total: 0, limit: 20, offset: 0 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("QueryLab", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("runs the query from URL parameters and shows the SQL beside the result", async () => {
    const fetchMock = stub({
      "/queries/catalog": catalog,
      "/queries/topic-authors": {
        items: [{ author_id: 28, full_name: "Ravi Moreau", paper_count: 13, first_year: 2023, last_year: 2025, institutions: ["Universidad del Sur Austral"] }],
        total: 1,
        limit: 20,
        offset: 0,
      },
    });
    render(
      <MemoryRouter initialEntries={["/query-lab?query=topic-authors&topic=1&topicName=federated+learning&from=2023&to=2025"]}>
        <QueryLab />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "Ravi Moreau" })).toBeTruthy();
    expect(screen.getByText("Universidad del Sur Austral")).toBeTruthy();
    const sql = screen.getByRole("complementary", { name: "SQL" });
    expect(within(sql).getByText(/fn_topic_authors\(:topic_id/)).toBeTruthy();
    expect(within(sql).getByText(/CREATE OR REPLACE FUNCTION/)).toBeTruthy();
    const call = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/queries/topic-authors"))!;
    expect(call).toContain("topic_id=1");
    expect(call).toContain("year_from=2023");
  });

  it("asks for parameters before running a query that needs them", async () => {
    stub({ "/queries/catalog": catalog });
    render(
      <MemoryRouter initialEntries={["/query-lab"]}>
        <QueryLab />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Choose a topic to run the query.")).toBeTruthy();
  });

  it("explains an empty cross-community result by naming the prerequisite job", async () => {
    stub({ "/queries/catalog": catalog, "/queries/cross-community-citations": { items: [], total: 0, limit: 20, offset: 0 } });
    render(
      <MemoryRouter initialEntries={["/query-lab?query=cross-community-citations"]}>
        <QueryLab />
      </MemoryRouter>,
    );
    expect(await screen.findByText("python -m graph.communities")).toBeTruthy();
  });
});
