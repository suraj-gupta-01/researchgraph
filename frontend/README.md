# frontend

React + TypeScript + Tailwind v4 + Vite + react-router-dom. Built against the
`researchgraph-frontend` skill's phase plan (`references/phases.md`).

```bash
npm install
npm run dev          # http://localhost:5173, API at VITE_API_URL (default http://localhost:8000)
npm run typecheck
npm run build
npm test
npm run gen:api       # regenerate src/api/schema.d.ts from a running backend's /openapi.json
npm run check:coverage
```

## Status: Phases 0 to 9 complete

All phases in `phases.md` are built. `npm run typecheck`, `npm test` (256 tests) and `npm run build` pass. `npm run e2e`
(Playwright, every route at 1440 and 390 px) is the Phase 9 gate. Its output is in `../docs/evidence/`.
The per-phase notes below were written as each phase shipped. Where a note says "until Phase N", that phase has since landed.

**Phase 0.** Design tokens (`src/index.css`), router shell with a global
topic-scope input and a data-source status dot (`src/app/`), the typed API
client generated from a live `/openapi.json` (`src/api/`), the full
component-primitive inventory (`src/components/`) exercised end to end at
`/styleguide` in dev builds, and the API-coverage registry
(`src/api/coverage.ts`) with `npm run check:coverage` passing clean.

**Phase 1 — Explore** (`src/features/explore/`). Topic search: summary
counts, year histogram doubling as the year filter, facets (authors,
institutions, venues, keywords, topics), ranked/sorted/paginated results, a
paper entity-peek drawer, and the full paper page (`src/features/papers/`)
with provenance table, cites/cited-by lists and the citation-chain tree.

**Phase 2 — Directories** (`src/features/{papers,authors,institutions,venues,topics}/`).
All five directories and entity pages: Papers (title/year/venue/author/
institution/topic filters), Authors, Institutions, Venues, Topics (parent/
child hierarchy). Every directory row and entity page links into the others.

**Phase 3 — Topic dynamics** (`src/features/trends/`, `src/charts/`, `src/lib/trend.ts`).
`/trends` ranks Emerging or Declining topics for a year (direction switch, year
stepper, URL state) and states the rule read from the run's algorithm string.
A row opens the topic-over-time figure in a drawer; the same figure sits on
every topic page. The figure draws paper-count bars, a growth panel with the
emerging and declining thresholds, and a trend-label strip, with dormant years
as gaps and a table view, SVG and CSV export. Its Method note omits the
"Methods & runs" link until Phase 8 (`linkToMethods: false` in
`TopicTrendPanel.tsx`); flip it then.

**Phase 4 — Communities** (`src/features/communities/`, `src/graph/`, `src/lib/graph.ts`).
`/communities` lists detected communities, scope-aware via the same top-bar
`?q=` as Explore (`ScopeContext` now treats `/communities` as a scoped page,
not just `/explore`); each row's label, member/paper counts, and — when
scoped — matched-paper/matched-member counts and top members. `/communities/:id`
adds the root topic, year span, top institutions, the label-evidence table
(with `topics_status`'s `ok`/`stale`/`missing`/`unavailable` states handled
distinctly), and a paginated member table with membership score as a bar. A
404 there always reads as "replaced by a newer run" — community IDs churn on
every `graph.communities` re-run, so that's overwhelmingly what a stale link
means.

`/communities/graph` (backed by the new G1 endpoint) is the force-directed
collaboration graph: `graph/forceLayout.ts` wraps d3-force (geometry only,
frozen after a fixed tick count and cached per data snapshot — a "Re-run
layout" button reseeds it); `graph/GraphCanvas.tsx` owns rendering and
interaction (d3-zoom pan/zoom, hover-dims-non-neighbors, click-to-select,
keyboard nav in community-then-degree tab order, Escape to deselect). Node
size is `sqrt(paper_count)`, color is the 8-slot categorical community
palette with an "Other communities" bucket past the 8th and "Unassigned"
always grey (`lib/graph.ts`'s `buildLegend`), and bridge researchers get an
ink ring scaled by `bridge_score`. A minimum-tie-strength slider hides weak
edges without re-running layout; a legend click isolates one community; a
"View as list" toggle swaps the canvas for a `DataTable` of the same nodes.
Clicking a node opens `AuthorPeek`, a drawer built entirely from that node's
own fields (no extra request).

**Resolved.** The Phase 4 README noted `d3-force`/`d3-zoom`/`d3-selection`
couldn't be installed in that build environment. Phase 5's environment has
registry access: `npm install`, `npm run typecheck`, `npm test` (118 tests)
and `npm run build` all pass clean against the real packages, so that
caveat no longer applies. One real (pre-existing, not Phase-5-introduced)
typecheck gap it surfaced along the way: `@types/d3-transition` was never
added even though `GraphCanvas.tsx` calls `.transition()` (via `d3-zoom`'s
transform calls) on a `d3-selection` selection — TypeScript doesn't pick up
that method's type augmentation without it. Fixed by adding the dev
dependency and a `import "d3-transition"` side-effect import in
`GraphCanvas.tsx`.

**Phase 5a — Author influence profile** (`src/features/authors/InfluencePanel.tsx`,
`src/lib/influence.ts`). Self-fetching panel (`GET /authors/{id}/influence`)
used on the author page and, once a node's own `bridge_score` shows a run
has happened, in the community graph's `AuthorPeek` drawer — one component,
one request shape, so both surfaces describe a bridge score identically.
Shows degree, betweenness and PageRank via `MetricBar`, each barred against
its 0..1 theoretical range rather than a live corpus-wide sample (a
documented simplification — see the doc comment on `METRIC_RANGE` in
`lib/influence.ts`; the actual corpus-relative ranking arrives with the
Bridge researchers board in Phase 5b, where many authors' rows sit side by
side). Bridge score plus `communities_touched`, with a `communities_touched
== 0 && bridge_score == 0` case flagged as "no ties recorded," not "low
influence" (api-coverage.md §3). Community ties via `TieBar` plus a
weight/share table, and a `Method` disclosure with the algorithm and run
date. The endpoint's two distinct 404s (author not found vs. author exists
but `graph.influence` hasn't scored them) are told apart by the FastAPI
detail text (`lib/influence.ts#isUnscored`) rather than guessed from status
alone.

Also from Phase 5: a "Bridge overlay" checkbox on `/communities/graph`
(`GraphCanvas`'s existing bridge-score ring, now toggleable rather than
always on — `showBridgeRings` prop, defaults to on so nothing else that
renders `GraphCanvas` changes behavior).

**Phase 6 — Interdisciplinary connections** (`src/features/connections/`, `src/charts/PairTrendChart.tsx`, `src/charts/PairMatrix.tsx`, `src/lib/convergence.ts`).
`/connections` ranks converging topic pairs for a year (`GET /topics/converging`), with
shared-paper counts now and the year before, growth, a score bar on the sequential ramp, a
Converging badge and a two-point sparkline. A row opens the pair's full co-occurrence
trajectory in a drawer (`GET /topics/pairs/{a}/{b}/trend`, gap G3, now shipped). 6c adds an
adjacency-matrix overview of the pairs on the current page (topics capped at 30, overflow
counted in the caption), and a client-side toggle that hides pairs containing the page's most
frequent topic. The toggle never re-queries or re-ranks: ranks keep the server's numbering,
and the hidden topic is pinned in the URL (`hideTopic`). Method disclosures say the list
carries no algorithm string (G4) via `Method`'s `algorithmNote`, and carry the "previously
separate" limitation. Once `/meta/runs` exists (Phase 8), replace
`CONVERGENCE_ALGORITHM_NOTE` with the run's string and flip `linkToMethods`.

**Phases 5b and 7 to 9** (built since the notes above): `/bridges` (ranked board,
tie evidence, bridge-score-vs-betweenness scatter, `min_communities` control);
`/explore/network` citation network, `/institutions/network` and
`/institutions/top`; the Home digest and `/methods` (every analysis's algorithm,
run date and provenance checks, which every Method disclosure now links to); sign-in with
roles, `/query-lab` (analyst) and `/accounts` (admin); nginx + CSP production
image. The Connections board's Method now shows the convergence run's
algorithm and date from `/meta/runs` (a fallback note covers a failed lookup).
On the paper page, each provenance row's record ID links out to that source's
record page (OpenAlex or Semantic Scholar), so the original paper can be read.

**Dense networks as matrices.** The institution network, each institution's
collaboration neighbourhood and the community collaboration graph are drawn by
`charts/AdjacencyMatrix.tsx`, not the force layout. On this corpus they are
98-100% dense (every pair collaborates), and a node-link drawing collapsed into
an overlapping blob with every edge hidden. The matrix gives each pair its own
cell, shaded on the blue sequential ramp. The community matrix is ordered by
community with each block outlined, and the bridge overlay is a bar beside each name.
The citation network (2% dense) keeps the node-link graph (`graph/GraphCanvas`),
which is the right tool for a sparse graph.

**Collaboration graph: community schematic first.** `/communities/graph` leads with
`charts/CommunityMap.tsx` inside a standard figure plate (caption, table view, SVG/CSV
download, Method). It's drawn as a journal figure per design-system.md §1 and §6: small nodes
(area = members) with a hairline ink outline, and hairline links labelled with their value
(the average tie between two communities' members, per member pair so size doesn't
inflate it). Labels are one line, with a label prefix shared by every community dropped and
stated once. A serif takeaway sentence (`lib/communityMap.ts#takeaway`) sits above it.
Selecting a community lists its members, most tied-in first, and its links. The 48 x 48
researcher matrix (2,304 cells for what is really about ten numbers) and the list are one
click away. An earlier version with large saturated bubbles and thick lines read as
toy-like and was replaced. It adapts to the number of communities: 1-2 draw in a short
frame, 3-8 on a ring (labels beside side nodes, above or below top and bottom ones),
and only the 8 largest are drawn (the rest are named in a note, following the 8-colour
rule). Past 10 links only the 8 strongest are drawn until a community is selected, and
values are printed on the 6 strongest. On a phone, more than 4 communities fall back to a
ranked list. `/styleguide` (dev builds) renders it at 1, 2, 3, 5, 6, 8 and 12
communities as a visual test bench.

**Bridge researchers: tie profile, not a scatter.** `/bridges` used to plot bridge
score against betweenness. With k communities the score tops out at 1 - 1/k (0.75
here), and every researcher sat at 0.71-0.75, so all points collapsed into one band
with overlapping labels. `charts/TieProfileChart.tsx` shows the score's input
instead: one 100% bar per ranked researcher, split by the share of their ties
going into each community. Betweenness moved to a table column. Community colours
follow one rule everywhere (largest community first, ties by id;
`lib/graph.ts#buildCategoricalLegend` and `lib/bridges.ts#communityKeys`), so a
community is the same colour on every page. The chart is opt-in ("Compare tie
profiles", below the table): 25 multi-colour bars at once proved too much to take in, so
the page leads with the table, whose "Most ties go to" column (the main community and
its share) carries the same story in one fact per row. `TieBar` takes the page's colours
when given (the bridges drawer); elsewhere it keeps its rank colouring.

## Known limitation on types

`src/api/schema.d.ts` was generated by starting the FastAPI app in-process
(no live Postgres/Mongo needed for `/openapi.json`) rather than against a
fully running stack, so it reflects the real contract but hasn't been
exercised against seeded data. Re-run `npm run gen:api` once the stack is up
if the backend changes.

Fonts (Source Serif 4, Hanken Grotesk) are bundled via @fontsource, so the
dashboard works offline.
