// Endpoint coverage registry — the single place that proves no backend
// capability is left without a screen. `scripts/check_api_coverage.py`
// diffs this file against the API's /openapi.json and fails on any gap.
//
// Rules
//  - Every operation in the API has exactly one entry: "METHOD /path/{param}".
//  - `surface` says which screen consumes it. `surface: null` is allowed
//    only with a `reason`.
//  - `gap` marks an endpoint that does NOT exist yet (see
//    references/api-coverage.md, "Backend gaps"). Once the backend ships it,
//    delete `gap` — the checker then requires it to exist in the OpenAPI.
//  - `phase` is the frontend phase (0-9) that owns the screen.

export interface Coverage {
  phase: number;
  surface: string | null;
  reason?: string;
  gap?: string;
}

export const COVERAGE: Record<string, Coverage> = {
  // ---- meta
  "GET /health": { phase: 0, surface: "Shell: data-source status indicator (Postgres / MongoDB)" },

  // ---- F1 search + papers
  "GET /search/overview": { phase: 1, surface: "Explore: summary, year brush, facets, notices" },
  "GET /search/papers": { phase: 1, surface: "Explore: ranked result list" },
  "GET /papers": { phase: 2, surface: "Papers directory with all filters" },
  "GET /papers/{paper_id}": { phase: 1, surface: "Paper page: abstract, authors, provenance, topics" },
  "GET /papers/{paper_id}/citations": { phase: 1, surface: "Paper page: cites / cited-by lists" },
  "GET /papers/{paper_id}/citation-chain": { phase: 1, surface: "Paper page: citation chain tree" },

  // ---- entity directories
  "GET /authors": { phase: 2, surface: "Authors directory" },
  "GET /authors/{author_id}": { phase: 2, surface: "Author page" },
  "GET /institutions": { phase: 2, surface: "Institutions directory" },
  "GET /institutions/{institution_id}": { phase: 2, surface: "Institution page" },
  "GET /institutions/countries": { phase: 7, surface: "Top institutions: papers-by-country figure" },
  "GET /institutions/{institution_id}/collaborators": { phase: 7, surface: "Institution page: collaborators + network" },
  "GET /venues": { phase: 2, surface: "Venues directory" },
  "GET /venues/{venue_id}": { phase: 2, surface: "Venue page" },
  "GET /topics": { phase: 2, surface: "Topics directory + topic typeahead everywhere" },
  "GET /topics/{topic_id}": { phase: 2, surface: "Topic page header, parent/children when present" },
  "GET /topics/{topic_id}/counts": { phase: 0, surface: null, reason: "M1 placeholder superseded by /topics/{id}; typed but not surfaced" },

  // ---- F3 emerging topics
  "GET /topics/{topic_id}/trend": { phase: 3, surface: "Topic-over-time chart with trend labels" },
  "GET /topics/trending": { phase: 3, surface: "Emerging / declining topics board" },

  // ---- F2 communities
  "GET /communities": { phase: 4, surface: "Communities index, topic-scoped with ?q=" },
  "GET /communities/{community_id}": { phase: 4, surface: "Community page: label evidence, institutions, span" },
  "GET /communities/{community_id}/members": { phase: 4, surface: "Community page: member table" },

  // ---- F4 influence and bridges
  "GET /authors/bridges": { phase: 5, surface: "Bridge researchers board, topic-scoped with ?q=" },
  "GET /authors/{author_id}/influence": { phase: 5, surface: "Author page: influence profile + community ties" },

  // ---- F5 convergence
  "GET /topics/converging": { phase: 6, surface: "Interdisciplinary connections board" },

  // ---- planned backend gaps (see references/api-coverage.md)
  "GET /communities/graph": { phase: 4, surface: "Community graph (zoom, click into node)" },
  "GET /search/citation-network": { phase: 7, surface: "Citation network of a search result set" },
  "GET /topics/pairs/{topic_a_id}/{topic_b_id}/trend": { phase: 6, surface: "Pair trajectory in the connections board" },
  "GET /meta/runs": { phase: 8, surface: "Methods & runs page; Home corpus line; Method disclosure on every figure" },
  "GET /institutions/network": { phase: 7, surface: "Institution collaboration network + institution-page ego network" },
  // ---- Section 9 query lab (G6, analyst role)
  "GET /queries/catalog": { phase: 9, surface: "Query lab: SQL panel (statement + live view/function definitions)" },
  "GET /queries/topic-authors": { phase: 9, surface: "Query lab: authors on a topic in a year range" },
  "GET /queries/cross-community-citations": { phase: 9, surface: "Query lab: cross-community citations" },
  "GET /queries/institution-topic-collaboration": { phase: 9, surface: "Query lab: institutions across two topics" },
  "GET /queries/topic-year-counts": { phase: 9, surface: "Query lab: papers per year for a topic" },

  // ---- authentication and roles (G7)
  "POST /auth/login": { phase: 9, surface: "Sign-in screen" },
  "POST /auth/logout": { phase: 9, surface: "Shell: Sign out" },
  "GET /auth/me": { phase: 9, surface: "Session check + role-aware shell (AuthContext)" },
  "GET /auth/users": { phase: 9, surface: "Accounts page (admin)" },
};
