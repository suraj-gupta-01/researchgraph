# ResearchGraph: M1 data foundation through M6 evaluation readiness

A database-driven dashboard for research communities, emerging topics, bridge
researchers and converging fields (PRD F1 to F6), on PostgreSQL + MongoDB,
FastAPI and React.

## Status

Every PRD milestone (M1 to M6) and every frontend phase (0 to 9) is built. F1 to F6
are all demonstrable end to end. Verified 2026-09-27:

| Check | Result |
|---|---|
| `docker compose up -d --build` from the repo | all four services healthy |
| Backend `pytest` (real PostgreSQL 16) | 301 passed, 3 skipped (data-conditional guards) |
| Frontend typecheck, `npm test`, `npm run build` | clean, 256 passed |
| API coverage (`npm run check:coverage`) | 40/40 operations surfaced or documented |
| Browser pass: 28 routes at 1440 and 390 px (overflow, console, CSP, axe WCAG 2.1 AA) | clean |
| Performance on a 3,000-paper corpus | every API median under 250 ms |

For the evaluation (PRD Section 10.1):
- **[docs/schema.md](docs/schema.md)**: ER diagram, keys and every FK, the 3NF argument (with the
  redundancies kept on purpose), the SQL vs MongoDB split, indexes, and where each Section 9 query runs.
- **[docs/evidence/README.md](docs/evidence/README.md)**: screenshots of every route, the browser
  audit, the large-corpus performance run, and what was verified live versus only in tests.

## Run it (one command)

```bash
cp .env.example .env            # optional: keys for real ingestion, your own accounts
docker compose up -d --build    # postgres, mongo, backend (:8000), frontend (:5173)
```

On an empty volume the backend loads the synthetic dev corpus and runs every
analysis before it reports healthy (`SEED_ON_EMPTY=true`, app/bootstrap.py).
The first start takes about a minute. Then open http://localhost:5173 and sign in:

| Account | Password | Role | Can use |
|---|---|---|---|
| `viewer` | `viewer-demo` | viewer | every dashboard, directory and entity page |
| `analyst` | `analyst-demo` | analyst | viewer, plus the **Query lab** (PRD Section 9 queries with their SQL) |
| `admin` | `admin-demo` | admin | analyst, plus the **Accounts** page |

These are demo accounts from `AUTH_USERS` in `.env`; change them before sharing
the stack (passwords may be pbkdf2 hashes: `docker compose exec backend python -m app.auth hash '<pw>'`).
Set `AUTH_ENABLED=false` for an open demo with no sign-in. API docs: http://localhost:8000/docs.

The frontend container serves the production build through nginx with a strict
Content-Security-Policy. For hot-reload development use the override:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Load real data instead of the synthetic corpus:

```bash
# real data (needs network + keys); set SEED_ON_EMPTY=false to start from an empty database
docker compose exec backend python -m ingestion.run_ingestion --topic "federated learning" --limit 200

# re-seed the synthetic corpus by hand (UI/API development only)
docker compose exec backend python -m ingestion.seed_dev
```

### Screens (Phases 0 to 9 of the frontend plan)

Overview (`/`), Explore + citation network (F1, `/explore`, `/explore/network`),
directories and entity pages, Trends (F3), Communities + community graph (F2),
Bridge researchers (F4), Interdisciplinary connections (F5), Institution
network and Top institutions (`/institutions/network`, `/institutions/top`),
Methods & runs (`/methods`, every analysis's algorithm, parameters, run date
and the provenance checks), Query lab (`/query-lab`, analyst) and Accounts
(`/accounts`, admin).

### Tests

```bash
# backend, against a real Postgres (the repo root must be mounted for the schema files)
docker compose run --rm -v "$PWD:/repo" -w /repo/backend backend sh -c "pip install -r requirements-dev.txt && pytest"
# frontend
cd frontend && npm ci && npm run typecheck && npm test && npm run build
```

### Security (M5)

- Sign-in with roles (viewer < analyst < admin); accounts from `AUTH_USERS`, never in code.
- Session: HMAC-signed, expiring token in an `HttpOnly; SameSite=Strict` cookie. The page script
  never sees it and nothing is stored in `localStorage`. The role is re-read from config on every
  request, so a demoted account loses access at once.
- CSRF: both POSTs require the `X-Requested-With: ResearchGraph` header and an allowed `Origin`.
- Login rate limit: 5 failures per IP+username or 20 per IP in 5 minutes gives a 429 with `Retry-After`.
- Every SQL value is a bound parameter; the frontend renders API values as text only (no `innerHTML`).
- nginx sends a CSP (`script-src 'self'`, `connect-src` = the API origin only, `frame-ancestors 'none'`) plus
  `nosniff`, `X-Frame-Options: DENY` and a referrer policy. Fonts are self-hosted, so no CDN is involved.

**Existing database volume?** Schema migrations after M1 are applied automatically only on
a fresh volume. For an existing one, apply what's missing:

```bash
docker compose exec -T postgres psql -U researchgraph -d researchgraph < database/migrations/02_m2.sql
docker compose exec -T postgres psql -U researchgraph -d researchgraph < database/migrations/03_m4.sql
docker compose exec -T postgres psql -U researchgraph -d researchgraph < database/migrations/04_m4_part3.sql
docker compose exec -T postgres psql -U researchgraph -d researchgraph < database/migrations/05_m4_part4.sql
```

(`06_query_lab.sql`, the Section 9 views and `fn_topic_authors`, is applied to an older volume
automatically by the backend at start-up.)

`03_m4.sql` adds `PAPER_AUTHOR_INSTITUTION` (exact per-paper author/institution attribution,
see "M4 — Pre-work" below). It has no data to backfill from the old `AUTHOR_INSTITUTION` rows
(they don't say which paper an affiliation came from), so on an existing volume, re-ingest
your corpus after applying it, then re-run `python -m graph.build_graph` and
`python -m graph.communities` so the institutional-collaboration signal picks up the corrected
attribution.

`04_m4_part3.sql` adds `AUTHOR_INFLUENCE` / `AUTHOR_COMMUNITY_TIE` (see "M4 — Part 3" below);
run `python -m graph.communities` then `python -m graph.influence` afterwards to populate them.

Tests:

```bash
docker compose exec backend pip install -r requirements-dev.txt
docker compose exec backend pytest            # 301 tests, real Postgres, Mongo via mongomock
cd frontend && npm test                       # UI smoke test against the running API + dev seed
```

## What M2 adds

```
database/migrations/02_m2.sql     Title full-text index, supporting indexes, v_paper_institution view
backend/app/
  routers/                        search, papers, authors, institutions, venues, topics
  search.py                       F1: candidate generation + aggregates (see ranking below)
  mongo_store.py                  abstract/keyword text search + keyword aggregation
  queries.py, sqlutil.py          shared paper-list query, pagination, LIKE escaping
backend/ingestion/
  derive_collaboration.py         fills COLLABORATION (M1 created it but never populated it)
  seed_dev.py                     synthetic dev dataset
backend/tests/                    pytest suite
frontend/                         React + TS + Tailwind dashboard
```

### API (all GET, paginated with `limit` ≤ 100 / `offset`)

| Endpoint | Notes |
|---|---|
| `/search/overview?q=` | counts, year histogram, top authors/institutions/venues, related keywords, topics |
| `/search/papers?q=&sort=` | ranked papers; `sort` = relevance, citations, year, title |
| `/papers` | filters: `q` (title), `year_from/to`, `venue_id`, `author_id`, `institution_id`, `topic_id` (includes descendant topics) |
| `/papers/{id}` | authors + affiliations, per-source provenance, abstract/keywords (Mongo), topics, corpus citation counts |
| `/papers/{id}/citations?direction=cites\|cited_by` | direct neighbours |
| `/papers/{id}/citation-chain?direction=&depth=` | recursive CTE, depth ≤ 5, cycle-safe |
| `/authors`, `/authors/{id}` | stats, institutions over time, top co-authors, papers by year |
| `/institutions`, `/institutions/{id}`, `/institutions/{id}/collaborators` | collaborators from COLLABORATION |
| `/institutions/network` | G5 (Phase 7): institution collaboration network in one request. Edges = COLLABORATION pairs aggregated to distinct shared papers (`min_shared`); nodes capped at `limit` by total shared papers (`truncated`). `center_id` returns that institution's ego network (partners plus partner-partner ties) |
| `/institutions/countries` | Top-institutions view: institutions, distinct papers and authors per country (SQL aggregate) |
| `/meta/runs` | G4 (Phase 8): last run of each analysis (algorithm, date, params, counts) from Mongo `graph_snapshot`, cross-checked against the Postgres Algorithm/Detection_Date stamps (`ok`, `not_run`, `postgres_only`, `mismatch`), plus the provenance checks |
| `/queries/*` | G6 (Phase 9, analyst): PRD Section 9 queries over SQL views and `fn_topic_authors` (06_query_lab.sql): `topic-authors`, `cross-community-citations`, `institution-topic-collaboration`, `topic-year-counts`, and `catalog` (each query's exact SQL, with view/function definitions fetched live from Postgres) |
| `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/users` | G7 (Phase 9): sign-in, session and roles; see Security (M5) |
| `/search/citation-network` | G2 (Phase 7): directed citation graph among the current search result set, same filters as `/search/papers` |
| `/venues`, `/venues/{id}` · `/topics`, `/topics/{id}` | |

Filters that apply to search (`year_from/to`, `author_id`, `institution_id`, `venue_id`) are shared by
`/search/overview` and `/search/papers`, so the facets and the list always agree. The year histogram
deliberately ignores the year filter so it can act as the year selector.

### F1 ranking (documented for the evaluator)

A paper is a candidate if it matches in any of three channels: **title** (Postgres full-text, websearch
syntax), **topic** (`PAPER_TOPIC` names, including descendants via a recursive CTE), **abstract/keywords**
(MongoDB `$text`, every term required). Relevance = `3·title + 2·topic + 1·abstract`, ties broken by
citation count. This is where MongoDB earns its place: abstracts are the unstructured text the
relational schema should not hold, and they are what makes a search for "federated learning healthcare"
find papers whose title never says it. If Mongo is down, search degrades to the Postgres channels and
the response says so (`meta.mongo`), and the UI shows a notice.

Before M3 runs, `PAPER_TOPIC` is empty, so the Topics facet is empty by design; the **Related keywords**
facet (from Mongo) fills that role until then.

### Security (M2 scope)

Every request value is a bound parameter; the only interpolated SQL is fixed whitelists (sort orders).
`ILIKE` inputs are escaped so `%` and `_` are literal. Query params are validated (ranges, enums, lengths;
invalid input → 422). CORS is limited to `CORS_ORIGINS`, GET only. Tests cover injection strings and
wildcard escaping. Authentication/RBAC came later, in M5; see Security (M5) above.

## Fixes to M1 (found while building M2)

These each corrupted data that M2 displays, and have regression tests.

1. **Semantic Scholar citation direction was inverted.** The adapter read `citations` (papers that cite
   this one) as outgoing edges; it now reads `references`.
2. **OpenAlex ORCIDs crashed the load.** OpenAlex returns ORCIDs as URLs (37 chars) but the column is
   `VARCHAR(25)`. ORCIDs are now normalized to the bare form, which also makes ORCID matching work across sources.
3. **Distinct people with the same name were merged.** Author fuzzy-matching ran against every author
   in the database, so two different "Wei Zhang"s collapsed into one node. Matching is now limited to the
   authors of the same DOI-matched paper, and never merges two authors from the same source.
4. **Merged papers/authors didn't record the second source's ID**, so that source's citations were
   silently dropped. IDs are now written back; citation linking resolves through `PAPER_SOURCE`.
5. **DOI case:** DOIs are lower-cased in both adapters (and existing rows by the migration).
6. **Fuzzy title match could merge papers with different DOIs** (two different DOIs are two works); it now
   skips candidates with a conflicting DOI.
7. **The paper review-queue insert bound a Python `dict` to a JSONB column** (would raise on first use);
   fixed, and queue rows now carry the real candidate rather than a placeholder note.
8. Undated papers (year 0) are skipped instead of polluting the year histogram.

## M3 — Part 1: NLP topic extraction

Split into three parts (see PRD Section 10): **1) topic extraction pipeline**,
2) graph construction from relational data, 3) provenance/merge logic
validated across sources. Part 1 fills F3/G3. **All three parts are now in.**

```
backend/ingestion/extract_topics.py   Populates TOPIC + PAPER_TOPIC
backend/tests/test_extract_topics.py  Coverage for both extraction lanes
```

Two lanes, both landing in the same TOPIC table, distinguished by
`PAPER_TOPIC.Extraction_Method`:

- `source_keyword` — the curated keywords the source already assigned
  (OpenAlex `keywords`, Semantic Scholar `fieldsOfStudy`, already stored in
  MongoDB by the M1/M2 loader). Treated as ground truth: `Relevance_Score = 1.0`.
- `tfidf` — corpus-wide TF-IDF (scikit-learn, unigram–trigram, `min_df=2`)
  over each paper's title + abstract. This is the part that does real NLP
  work: a phrase every paper in the demo corpus shares (e.g. "federated
  learning") gets diluted by IDF, while phrases that mark out a sub-topic
  (e.g. "differential privacy", "medical imaging") float to the top. Score
  is that paper's TF-IDF weight, min-max normalized against its own top
  term, thresholded at 0.15 to drop the noisy tail.

Run it (also wired into the end of `run_ingestion` and `seed_dev`, so a
normal `docker compose exec backend python -m ingestion.seed_dev` now
populates topics too):

```bash
docker compose exec backend python -m ingestion.extract_topics
```

Idempotent — safe to re-run after every ingestion batch; upserts by
`(Paper_ID, Topic_ID)` and TOPIC names are deduped case-insensitively.

**Deliberately out of scope for Part 1** (left for the team / a later
milestone, not silently skipped):
- **Topic hierarchy** (`Parent_Topic_ID`) — nothing in the title/abstract
  text or source keywords implies a clean parent/child relationship, and
  guessing one from substring containment would invent as much nonsense as
  signal. Every topic this job creates has `Parent_Topic_ID = NULL`.
- **Embedding-based extraction** (SPECTER etc.) — Semantic Scholar can ship
  an embedding, but nothing in the M1/M2 loader persists it to Mongo yet,
  so there's nothing to cluster on today.

## M3 — Part 2: Graph construction

```
backend/graph/build_graph.py      Builds the Author-Paper-Institution-Topic-Venue-Citation graph
backend/tests/test_build_graph.py Coverage for both graphs + the Mongo snapshot
```

Two NetworkX graphs, built straight from Postgres (no new tables — this
milestone is construction, not the algorithms; Louvain/centrality/PageRank
are M4, per PRD Section 10):

- **`build_full_graph()`** — the literal heterogeneous graph from PRD
  Section 7.2. Every `AUTHOR`/`PAPER`/`INSTITUTION`/`TOPIC`/`VENUE` row is a
  node (`"{table}:{id}"`); every `AUTHORSHIP`/`AUTHOR_INSTITUTION`/
  `PAPER_TOPIC`/`CITATION` row is an edge, plus a `published_in` edge for
  each paper's venue (VENUE is 1:M so it doesn't need its own join table).
  This is the full entity graph — the substrate for anything that needs
  more than authors, e.g. an F4 bridge score that should count institutions
  or topics, not just co-authorship.
- **`build_author_collaboration_graph()`** — an undirected, weighted
  Author-Author graph, because `RESEARCH_COMMUNITY`/`COMMUNITY_MEMBER` (what
  M4's Louvain run populates) only track `Author_ID`, so the community
  detection input has to already be author-only. Follows F2's edge list
  exactly — co-authorship (`AUTHORSHIP`), citation (`CITATION`), shared
  topic (`PAPER_TOPIC`), institutional collaboration (`COLLABORATION`) —
  each contributing independently to the same edge's weight (and recorded
  under its own attribute, e.g. `coauthor_weight`, so a later community
  label can explain *why* two authors are linked):

  | Signal | Weight | Notes |
  |---|---|---|
  | Co-authorship | 3.0 / shared paper | direct evidence, weighted highest |
  | Citation | 1.0 / citing-cited author pair | connects authors across papers, not just within one |
  | Shared topic | 0.5 / topic | only for topics tagged on <40% of the corpus — a topic on virtually every paper (e.g. "federated learning" here) is corpus noise, not a community signal, mirroring Part 1's own IDF-dilution reasoning |
  | Institutional collaboration | 0.75 / linked institution pair | from `COLLABORATION`; can surface a link the other three signals miss |

Run it (wired into the end of `run_ingestion` and `seed_dev`, after topic
extraction):

```bash
docker compose exec backend python -m graph.build_graph
```

Idempotent in the sense that matters here: it only reads Postgres and
writes nothing back to it, so re-running never duplicates anything. The one
side effect is a single upserted summary document, `graph_snapshot` /
`_id: "latest"` in MongoDB (PRD 6.4's "graph-analysis result blobs") — node
and edge counts by type for the full graph, and node/edge/weight stats for
the collaboration graph — so a dashboard or M4 can check the graph is
populated without rebuilding it. If Mongo is unreachable the functions
still return the summary; only that persistence step is skipped.

**Deliberately out of scope for Part 2:**
- **Running any graph algorithm** (Louvain, centrality, PageRank, link
  prediction) — that's M4 (F2/F4/F5). This milestone only builds the graph
  those algorithms will run on.
- **Per-paper institution precision in the institutional-collaboration
  signal** — at the time this milestone was built it used every institution
  an author has ever been affiliated with (`AUTHOR_INSTITUTION`, no year
  filter), not just the institution on the specific paper `COLLABORATION`
  recorded the pair from. Fixed in "M4 — Pre-work: `PAPER_AUTHOR_INSTITUTION`",
  below.

**Bug found while building Part 2:** `extract_topics.py`'s TF-IDF scores
were `numpy.float64` (straight off the sparse matrix), and psycopg2 has no
adapter for that type — every TF-IDF row raised `InvalidSchemaName` the
first time this ran against a real (non-mocked) Postgres. Part 1's own test
suite didn't catch it because `mongomock` never made the code path touch a
real database engine end-to-end the way this milestone's tests do. Fixed by
casting to `float()` before the score is bound as a query parameter.

## M3 — Part 3: Provenance / merge validation

```
backend/ingestion/validate_provenance.py   Read-only audit of cross-source merges (PRD 6.2 / 11)
backend/tests/test_validate_provenance.py  Clean-corpus tests + mutation tests (inject a corruption, expect red)
```

Entity resolution across OpenAlex and Semantic Scholar is the PRD's highest-risk
piece, and the M1 bugs listed above (inverted citations, merged same-name authors,
lost second-source IDs, DOI case) all failed silently. This is the safety net that
makes that class of bug loud. It never repairs data; it audits what the loader left.

| Check | Fails when | Traces to |
|---|---|---|
| `paper_source_coverage` | a paper has no `PAPER_SOURCE` row | PRD 6.2 provenance |
| `paper_source_unique` | one `(source, record id)` maps to 2 papers | wrong merge |
| `paper_source_id_columns` | `PAPER.Openalex_/Semantic_Scholar_Paper_ID` disagrees with, or is missing next to, `PAPER_SOURCE` | M1 fix #4 |
| `doi_lowercase`, `doi_unique` | a DOI is not lower-cased, or 2 papers share one | M1 fixes #5, #6 |
| `orcid_format`, `orcid_unique` | ORCID stored as a URL, or on 2 authors | M1 fix #2 |
| `author_source_ids_unique` | one source author id sits on 2 authors | wrong merge |
| `author_cross_source_evidence` | an author holds BOTH source ids but has no ORCID and no paper reported by both sources | M1 fix #3 |
| `citation_integrity` | a paper cites itself | wrongly merged works |
| `citation_count_nonnegative` | a citation count is negative | bad source data |
| `citation_count_provenance` | `PAPER.Citation_Count` equals no `Source_Citation_Count`; **warns** when it ignores the preferred source (Semantic Scholar) | PRD 6.2 conflicts |
| warnings | same-name co-authors on one paper, a citation pointing forward in time, pending `ENTITY_RESOLUTION_QUEUE` rows | suspicious but can be legitimate real data |

Statuses are `pass` / `fail` / `warn` / `skipped`. **`skipped` is never a pass**: its
detail says why (a missing table or column). Table and column names are discovered
from the live catalog, so a rename shows up as an explicit skip, not a crash.

```bash
docker compose exec backend python -m ingestion.validate_provenance   # exit code 1 on any fail
```

Also runs at the end of `run_ingestion` and `seed_dev` (logs only, never aborts the
load) and upserts its report to MongoDB as `graph_snapshot` / `_id: "provenance"`.

**Tests.** Besides checking the synthetic corpus passes with every check evaluated (none
skipped), each check has a mutation test run inside a rolled-back transaction, so a check
that can only ever pass would be caught. Where the schema itself forbids the corruption
(UNIQUE / CHECK), the constraint is dropped inside that same rolled-back transaction, so
the check's own logic is still proven and the schema is never modified.

**Small fixes made in Part 3:**
- `extract_topics` re-runs now replace a paper's previous `tfidf` rows instead of leaving stale ones.
- `build_author_collaboration_graph` normalises `COLLABORATION` pairs to (low, high) before use.
  Belt and braces only: the schema's `CHECK (Institution_A_ID < Institution_B_ID)` already
  guarantees this today.
- The two-"Wei Zhang" test no longer breaks if the random name pool produces a third one.

**Deliberately out of scope for Part 3:** topic hierarchy, embeddings, and any repair logic.
(`PAPER_AUTHOR_INSTITUTION`, flagged here in earlier drafts as a schema decision to make later,
is now done — see below.)

## M4 — Pre-work: `PAPER_AUTHOR_INSTITUTION`

```
database/migrations/03_m4.sql   PAPER_AUTHOR_INSTITUTION table, v_paper_institution redefined
```

Fixes the M2 known limit below: `AUTHOR_INSTITUTION` is keyed per (author, year), so an author
with two affiliations in the same year was credited with both on every paper they wrote that
year. `PAPER_AUTHOR_INSTITUTION (Paper_ID, Author_ID, Institution_ID)` records the affiliation
actually attached to each authorship — data the loader already receives per paper but previously
wrote down at the coarser per-year grain. Its primary key is all three columns; a composite
foreign key to `AUTHORSHIP (Paper_ID, Author_ID)` means a row can't reference an authorship that
doesn't exist. `AUTHOR_INSTITUTION` is unchanged and kept — it's the PRD baseline table and still
gives per-author affiliation history independent of any one paper — so the two tables partly
duplicate each other by design.

Three call sites pick this up:
- **`loader.py`** writes a `PAPER_AUTHOR_INSTITUTION` row alongside every `AUTHOR_INSTITUTION`
  row it already writes, from the same source authorship record.
- **`v_paper_institution`** (the view search facets, institution pages and
  `derive_collaboration` all read) is redefined to select from `PAPER_AUTHOR_INSTITUTION`
  instead of joining `AUTHOR_INSTITUTION` on `(author, publication year)`. Everything that reads
  the view picks up the fix with no changes of its own.
- **`build_graph._institution_author_map`**, the institutional-collaboration signal's source for
  F2 community detection (M3 Part 2's known limit above), now reads `PAPER_AUTHOR_INSTITUTION`
  instead of `AUTHOR_INSTITUTION`.

Coverage is unchanged: Semantic Scholar authorships carry no institutions, so only
OpenAlex-sourced papers get rows, same as `AUTHOR_INSTITUTION` today. There's nothing to backfill
existing data with (old `AUTHOR_INSTITUTION` rows don't record which paper they came from) — see
the re-ingestion note under "Existing database volume?" above.

## M4 — Analytics (split into four parts)

PRD Section 10 puts F2–F5 in M4. They are built as four parts, ordered by dependency:

| Part | Scope | Depends on | Status |
|---|---|---|---|
| **1** | **Community detection (F2)** — Louvain, labels, `RESEARCH_COMMUNITY` / `COMMUNITY_MEMBER`, `/communities` API | M3 graph + topics | **done** |
| **2** | **Emerging-topic detection (F3)** — `TOPIC_SNAPSHOT`, `RESEARCH_TREND`, one documented growth formula and threshold | M3 topics | **done** |
| **3** | **Bridge researchers & influence (F4)** — degree / betweenness / PageRank, bridge score across Part 1's communities | Part 1 | **done** |
| **4** | **Topic convergence (F5)** — topic pairs whose co-occurrence is rising | M3 topics | **done** |

Part 4 doesn't need communities and can run in parallel with (or before/after) Part 3. Like Parts 1-3, it is split
into a pure-logic half and an I/O half:

| Sub-part | Scope | Status |
|---|---|---|
| **4a** | Schema decision + `graph.convergence_core` (pure growth-rate/threshold logic, unit-tested, no I/O) | **done** |
| 4b | `graph.convergence` (runs 4a's logic against Postgres, writes `TOPIC_PAIR_TREND`, overwrites the `Converging` label on `RESEARCH_TREND` for topics in a top pair, Mongo snapshot), `/topics/converging` API, wiring into `run_ingestion`/`seed_dev` | **done** |

**Decided in 4a** (was open in earlier drafts of this README): `RESEARCH_TREND` is keyed per topic, but F5 ranks topic
*pairs*, so a small dedicated table — see "M4 — Part 4a" below.

## M4 — Part 1: Community detection (F2)

```
backend/graph/community_core.py      Pure logic: Louvain (deterministic), membership score, labels (no I/O)
backend/graph/communities.py         Runs it against Postgres, stores the run, snapshots to Mongo
backend/app/routers/communities.py   GET /communities, /communities/{id}, /communities/{id}/members
backend/tests/test_community_core.py 20 unit tests, no database
backend/tests/test_communities.py    19 tests: persistence, replace semantics, API (real Postgres)
```

```bash
docker compose exec backend python -m graph.communities                       # detect + store
docker compose exec backend python -m graph.communities --resolution 1.3 --dry-run   # try parameters, write nothing
```

Also runs at the end of `run_ingestion` and `seed_dev`, after topic extraction and graph construction. It needs
`PAPER_TOPIC` filled to label communities; without it they are found but named `Community <n>`.

**Method.**
- *Detection:* Louvain (NetworkX) on the weighted author-collaboration graph from M3 Part 2 — the four F2 signals
  (co-authorship, citation, shared topic, institutional collaboration). Louvain is a hard partition: an author is in at
  most one community. Isolated authors never enter the algorithm; communities under `--min-size` (default 3) are not
  stored, and the run reports how many authors that leaves unassigned.
- *Determinism:* the graph is rebuilt in sorted order and Louvain is seeded (default 42), so the same data and
  parameters give the same partition regardless of the order SQL returned rows in. (Community IDs are new each run.)
- *`Membership_Score`:* share of an author's total tie weight that stays inside their community, 0–1. Low = ties spread
  across communities; Part 3 builds the bridge score on this.
- *Label* (`"Federated Learning + Privacy"`): TF-IDF one level up from `extract_topics`. Each paper counts for a community
  in proportion to the share of its authors who are members. `share(t)` = weighted fraction of the community's papers
  tagged `t`; `score(t) = share(t) · ln(1 / corpus_share(t))`, so a topic on every paper scores 0 and can never be the
  distinctive term. `Root_Topic_ID` = the topic with the largest share (it anchors the label; it is *not* a hierarchy
  parent, since `Parent_Topic_ID` is still empty). Label = root + the highest-scoring other topic. A topic needs ≥ 20%
  share to be considered.

**Run semantics (NFR: auditability).** A run *replaces* the previous one, in one transaction, so Postgres always holds
one consistent set and a failed run leaves the old one intact. All rows of a run share `Detection_Date`, and
`Algorithm` carries the parameters (`louvain(resolution=1,seed=42)`), so a stored result can be reproduced from Postgres
alone. No history is kept; the Mongo snapshot (`graph_snapshot` / `_id: "communities"`) holds the *last* run's
parameters, modularity and per-community label evidence. If Mongo is down the run still succeeds.

**API** (GET, paginated with `limit` ≤ 100 / `offset`):

| Endpoint | Notes |
|---|---|
| `/communities` | all communities, largest first, each with `label`, `member_count`, `paper_count`, `top_members` (`top_members=0..20`) |
| `/communities?q=` | F2's acceptance case. Reuses the F1 candidate search, so only communities whose members wrote papers matching the topic, ranked by `matched_papers` (then size). A paper co-written across communities counts for each. `search_meta` reports the Mongo status like `/search/overview` |
| `/communities/{id}` | label, root topic, year span, top institutions (by member count), top members, and `topics` — the scored evidence behind the label. `topics_status`: `ok`, `stale` (Mongo holds a different run), `missing`, or `unavailable` (Mongo down); Postgres stays authoritative, so the rest of the response is unaffected |
| `/communities/{id}/members` | every member, most-published first, with `membership_score` |
| `/communities/graph` | G1 (added for the frontend's Phase 4 community-graph screen): the same author-author collaboration graph `graph.communities` partitions, as nodes/edges. `q` scopes to authors of matching papers; `min_weight` drops weak edges; `max_nodes` (default 400) caps the result by weighted degree and reports `truncated`. Needs no prior run — `community_id`/`bridge_score` are `null` until `graph.communities`/`graph.influence` have run |

The frontend's community-graph screen (`/communities/graph`) now exists (Phase 4) and consumes the endpoint above.

**Verification status.** `docker compose exec backend pytest` has now been run for real against a live PostgreSQL
16 instance (and MongoDB stood in for by `mongomock`, same as the suite does in CI): all 150 tests pass, including
`test_community_core.py` (20/20), `test_communities.py` (19/19, `LATERAL`/`ANY(:ids)`/window-function SQL and the
real SQLAlchemy/Postgres dialect included), and the M4 Part 2 tests below. If a future change breaks something here,
suspect that change before the harness.

**Known limits.**
- In the simulation, the dev-scale graph was nearly complete (every author pair had an edge), because the shared-topic and
  institutional signals connect almost everyone in a 48-author corpus, so modularity was low (≈ 0.05–0.19) even
  though the clusters were recovered. Real, larger corpora are sparser. If communities look mushy, tune with
  `--resolution … --dry-run` before touching the weights in `build_graph.py`.
- Labels are only as good as topic extraction: TF-IDF phrases can give an awkward second term.
- Louvain output can differ between NetworkX versions (pinned 3.3.0); determinism holds for a fixed version.

## M4 — Part 2: Emerging topic detection (F3)

```
backend/graph/trend_core.py          Pure logic: growth-rate formula, Emerging/Stable/Declining thresholds (no I/O)
backend/graph/trends.py              Runs it against Postgres (TOPIC_SNAPSHOT + RESEARCH_TREND), snapshots to Mongo
backend/app/routers/topics.py        GET /topics/{id}/trend, /topics/trending  (added to the existing topics router)
backend/tests/test_trend_core.py     18 unit tests, no database
backend/tests/test_trends.py         19 tests: persistence, replace semantics, API (real Postgres)
```

```bash
docker compose exec backend python -m graph.trends                    # aggregate + classify + store
docker compose exec backend python -m graph.trends --dry-run          # compute and log, write nothing
docker compose exec backend python -m graph.trends --min-relevance 0.5
```

Also runs at the end of `run_ingestion` and `seed_dev`, after topic extraction (order versus community detection
doesn't matter — F3 only reads `PAPER_TOPIC`/`PAPER`/`AUTHORSHIP`/`v_paper_institution`, not `RESEARCH_COMMUNITY`).
Without `PAPER_TOPIC` filled, it produces an empty result rather than an error.

**Method.**
- *Aggregation:* one `TOPIC_SNAPSHOT` row per (topic, year) with ≥ 1 paper tagged above `Relevance_Score ≥ 0.3` (the
  same floor `graph.communities` uses for shared-topic edges and label evidence, so a chart and a community label
  agree on what counts as "this paper is about that topic"). `Paper_Count`/`Citation_Count` come straight off `PAPER`
  per topic/year; `Author_Count`/`Institution_Count` are `COUNT(DISTINCT ...)` over `AUTHORSHIP`/`v_paper_institution`
  joined back in without fanning out the paper-level sum (three separate `GROUP BY`s joined at the topic/year grain,
  not one query with `LEFT JOIN`s that would double-count `Citation_Count`). This is also PRD Section 9's demo
  aggregation query ("`Publication_Year → COUNT(*)` per topic"), run live.
- *Growth_Rate:* `(P(Y) - P(Y-1)) / P(Y-1)` where `P` is `Paper_Count`, computed from this run's own in-memory year
  series per topic (not by reading back a just-written row), clamped to `[-1.0, 9.9999]` to fit `NUMERIC(6,4)`. A
  topic with no snapshot the year before (debut, or a gap year) has nothing to divide by, so `Growth_Rate` is set to
  a fixed constant (`2.0`, i.e. "≥ 200%") instead of `NULL` — keeps every classified period rankable by the same
  column.
- *Trend_Label:* `Emerging` if `Growth_Rate ≥ 0.30`, `Declining` if `≤ -0.30`, else `Stable` — but only once the
  *period's own* `Paper_Count ≥ 3`; below that floor a swing is more likely sample noise than signal (a topic going
  from 1 to 2 papers is "+100%" by the formula but tells you nothing), so it is reported `Stable` regardless of the
  computed rate. `Converging` is a valid label (schema `CHECK`) but is never written here — it is Part 4's, for
  topics that show up in a top rising topic-pair; since `RESEARCH_TREND`'s primary key is `(Topic_ID, Period_Year)`,
  Part 4 will need to overwrite this module's label for a period rather than add a second row for it.

**Run semantics (NFR: auditability).** Same shape as Part 1: a run *replaces* the previous one — `TOPIC_SNAPSHOT` is
fully recomputed, and `RESEARCH_TREND` rows sharing this run's `Algorithm` prefix (`growth_rate(...)`) are replaced,
leaving any future Part 4 `Converging` rows (a different `Algorithm` string) untouched. All `RESEARCH_TREND` rows of
a run share one `Detection_Date`; `Algorithm` carries the thresholds (`growth_rate(em=0.3,dec=-0.3,min=3)` — kept
short to fit `VARCHAR(50)`), so a stored result can be reproduced from Postgres alone. The Mongo snapshot
(`graph_snapshot` / `_id: "trends"`) holds the last run's parameters and label counts, for auditability, not as a
data source — the dashboard should read `TOPIC_SNAPSHOT`/`RESEARCH_TREND` directly. If Mongo is down the run still
succeeds.

**API** (GET, paginated with `limit` ≤ 100 / `offset` on `/topics/trending`):

| Endpoint | Notes |
|---|---|
| `/topics/{id}/trend` | full `TOPIC_SNAPSHOT`/`RESEARCH_TREND` history for one topic, oldest year first — F3's acceptance criterion, "a topic-over-time chart and a trend label". `points` is `[]` (not 404) until `graph.trends` has run; the topic itself 404s if it doesn't exist |
| `/topics/trending?direction=emerging\|declining&year=` | topics currently classified `Emerging`/`Declining`, most extreme first (`Score DESC` for emerging, `ASC` for declining). `year` defaults to the latest period with that label — a topic can be `Emerging` in an earlier year and `Stable`/absent in the latest one, so it will not always appear on the default view; pass `year` explicitly to look at a specific period |

Dashboard surface: `/trends` and the topic-over-time figure on every topic page (frontend Phase 3).

**Verification status.** Run for real against the same live PostgreSQL 16 instance as Part 1 (Mongo stood in for by
`mongomock`): `test_trend_core.py` (18/18) and `test_trends.py` (19/19) both pass, on the synthetic dev corpus, which
weights more papers into later years and tags every paper "federated learning" — its snapshot does show real growth
(`Emerging` in 2018–2019 and 2022–2024, cooling to `Stable` by 2025 as the topic matures), rather than only exercising
the code path on shapes.

**Known limits.**
- A topic that goes fully dormant (0 papers) the year after being active gets no `TOPIC_SNAPSHOT` row for that
  dormant year — there is nothing to aggregate — so it simply stops appearing rather than showing a `Declining`
  period into zero. A chart built off `TOPIC_SNAPSHOT` should treat a missing year as "no data", not "zero".
- `MIN_PAPERS_FOR_TREND = 3` and the ±30% thresholds are one reasonable, documented choice, not derived from the
  corpus; tune them in `trend_core.py` (and expect every `test_trend_core.py` boundary test to need updating with
  them; the exact-threshold tests pin `0.30`/`-0.30`/`3` on purpose).
- `Score` on `RESEARCH_TREND` currently just mirrors `Growth_Rate`; there was nothing else meaningful to put there
  for a growth-based trend. Part 4 will likely want its own scale for `Converging` periods.

## M4 — Part 3: Researcher influence & bridge detection (F4)

```
backend/graph/influence_core.py      Pure logic: degree/betweenness/PageRank + participation-coefficient bridge score (no I/O)
backend/graph/influence.py           Runs it against Postgres (AUTHOR_INFLUENCE + AUTHOR_COMMUNITY_TIE), snapshots to Mongo
backend/app/routers/authors.py       GET /authors/bridges, /authors/{id}/influence  (added to the existing authors router)
database/migrations/04_m4_part3.sql  AUTHOR_INFLUENCE, AUTHOR_COMMUNITY_TIE
backend/tests/test_influence_core.py 19 unit tests, no database
backend/tests/test_influence.py      18 tests: persistence, replace semantics, API (real Postgres)
```

```bash
docker compose exec backend python -m graph.influence           # compute + store
docker compose exec backend python -m graph.influence --dry-run # compute and log, write nothing
```

Also runs at the end of `run_ingestion` and `seed_dev`, after `graph.communities` (F4's bridge score is computed
*against* Part 1's partition — see "Method" below); unlike Parts 1/2/4, there is nothing to tune from the CLI, since
none of the four metrics have a free parameter.

**Graph.** Runs on `graph.build_graph.build_author_collaboration_graph()` — the same weighted Author–Author graph
Part 1's Louvain run partitions — not the full heterogeneous graph, so "degree"/"betweenness"/"PageRank" mean the
same thing here as "the graph community detection ran on", and a bridge score against `RESEARCH_COMMUNITY` is the
natural follow-on question to Part 1's partition: given that partition, who sits between the parts it found?

**Method** (all four in `graph/influence_core.py`, each independently documented and unit-tested — the PRD lists
them as four separate outputs, not one blended score):
- *Degree centrality:* NetworkX's own unweighted definition (`degree / (n - 1)`) — the PRD says "degree centrality"
  without qualification, which is the textbook structural metric; the weighted variant ("strength") is a different,
  undocumented number under the same name, so it isn't used here.
- *Betweenness centrality:* weighted, but computed on a **distance-inverted** copy of the graph
  (`distance = 1 / weight`). This graph's edge weight is a *strength* (higher = closer), while NetworkX's
  shortest-path algorithms read `weight` as a *distance* (higher = further) — passed through unmodified, a strong
  tie would look like the longer detour and betweenness would reward exactly the wrong paths. This is the standard
  fix for that mismatch (see e.g. Newman, "Analysis of weighted networks", 2004).
- *PageRank:* weighted, weight used as-is — PageRank's transfer model already reads a larger weight as "more
  importance flows along this edge", the same direction this graph's weight already points in, so (unlike
  betweenness) no inversion is needed.
- *Bridge score:* the **participation coefficient** (Guimera & Amaral, "Functional cartography of complex metabolic
  networks", *Nature*, 2005) — a standard, published, non-arbitrary measure of exactly what F4 asks for
  ("connecting ≥ 2 distinct communities"): `P_i = 1 - Σ_c (k_ic / k_i)²`, where `k_ic` is an author's total tie
  weight into community `c`'s members and `k_i` is their total tie weight into *any* community's members (ties to
  authors outside every community don't count toward either sum). `P_i` is 0 when every tie lands in one community
  (or the author has no ties into any), and approaches 1 the more evenly ties spread across many — i.e. the *spread*
  drives the score, not just the raw count. An author doesn't need to be a `COMMUNITY_MEMBER` themselves to get a
  bridge score: someone Louvain left unassigned (isolated, or in a too-small community) whose neighbours span two
  communities is exactly the broker this metric is meant to catch, so `AUTHOR_INFLUENCE` covers every author in the
  collaboration graph, not only community members. `Communities_Touched` is stored alongside `Bridge_Score` because
  0.0 alone can't distinguish "touches nothing" from "deeply embedded in exactly one community" — F4's own bar
  (`≥ 2`) is a threshold on `Communities_Touched`, not on `Bridge_Score`. `AUTHOR_COMMUNITY_TIE` holds the per-tie
  evidence (weight and share into each touched community) behind every score, largest tie first.

**Run semantics (NFR: auditability).** Unlike `RESEARCH_COMMUNITY`/`TOPIC_SNAPSHOT` (keyed on an `Algorithm` prefix
so differently-parametrized runs can be told apart), `AUTHOR_INFLUENCE` is one row per author with no parameters to
vary between runs (`influence_core.algorithm_label()` takes no arguments), so a run simply *replaces* the whole
table — both `AUTHOR_INFLUENCE` and `AUTHOR_COMMUNITY_TIE`, in one transaction, so a failure leaves the previous run
in place rather than a half-written one. `AUTHOR_COMMUNITY_TIE` references `RESEARCH_COMMUNITY` with
`ON DELETE CASCADE`, so a later `graph.communities` re-run (which deletes and reinserts `RESEARCH_COMMUNITY`) drops
this run's ties along with it — re-run `graph.influence` afterwards to pick the new partition back up. The Mongo
snapshot (`graph_snapshot` / `_id: "influence"`) holds the last run's counts and top bridge researchers, for
auditability, not as a data source. If Mongo is down the run still succeeds.

**API** (GET, paginated with `limit` ≤ 100 / `offset` on `/authors/bridges`):

| Endpoint | Notes |
|---|---|
| `/authors/bridges?min_communities=&q=` | bridge researchers ranked by bridge score, floored at `Communities_Touched ≥ min_communities` (default 2, F4's own bar). With `q=`, F4's acceptance case — "for a searched topic, the system lists researchers who publish across the topic's detected communities, ranked by bridge score": reuses F1's candidate search to find which communities the topic matches (the same join `/communities?q=` uses), keeps only authors bridging `min_communities`+ of *those* communities, and ranks by how many of the matched communities they bridge, then overall bridge score. Empty (not an error) until `graph.influence` has run |
| `/authors/{id}/influence` | one author's full profile: all four metrics plus the per-community ties behind the bridge score. 404 if the author doesn't exist; 404 (distinct message) if `graph.influence` hasn't run yet for them |

The Phase 4 community graph (`/communities/graph` on the frontend) now draws each researcher's bridge score as a
ring around their node, and `/bridges` (frontend Phase 5b) is the ranked bridge-researchers board with its
tie evidence and a bridge-score-vs-betweenness scatter.

**Verification status.** Run for real against the same live PostgreSQL 16 instance as Parts 1/2 (Mongo stood in for
by `mongomock`): `test_influence_core.py` (19/19) and `test_influence.py` (18/18) both pass. On the synthetic dev
corpus every author scores (48/48) and, because the corpus deliberately mixes ~20% of each paper's authors across
its four planted clusters (see M4 — Part 1), *every* author ends up touching ≥ 2 communities — a real but
corpus-specific result (see Known limits), not a sign the ≥ 2 floor is doing nothing.

**Known limits.**
- On this dev corpus the ≥ 2 floor doesn't discriminate (every author clears it, see above) because the planted
  cross-cluster mixing is heavy relative to the corpus's small size; on a real, larger corpus with sparser
  cross-community collaboration, the floor should behave as intended. Worth re-checking against a real ingested
  corpus once one is available.
- Betweenness centrality is computed exactly (not `k`-sampled), fine at class-project scale (PRD Section 11) but
  `O(n·m)`; a much larger corpus would want NetworkX's `k=` sampling parameter, at the cost of the result no longer
  being exactly reproducible run to run even on a fixed graph.
- The participation coefficient only "sees" ties into *assigned* community members; an author whose only ties are to
  other unassigned authors gets `Communities_Touched = 0` regardless of how well-connected they otherwise are — this
  is intentional (there is no third community for that tie to count toward) but means the metric is only as good as
  Part 1's partition coverage.

## M4 — Part 4a: Topic convergence — schema + core logic (F5, pure half)

```
database/migrations/05_m4_part4.sql   TOPIC_PAIR_TREND (schema decision, see comment in the migration)
backend/graph/convergence_core.py     Pure logic: co-occurrence growth-rate + converging threshold (no I/O)
backend/tests/test_convergence_core.py 15 unit tests, no database
```

Same split as Parts 1-3: the pure, unit-testable half goes in first (`community_core` / `trend_core` /
`influence_core`'s sibling), the Postgres/Mongo/API half (`graph.convergence`, Part 4b) follows against it.

**Schema decision** (left open in earlier drafts of this README): F5 ranks topic *pairs*, and `RESEARCH_TREND` is
keyed per single topic, so pair results need a home of their own. Added `TOPIC_PAIR_TREND` (`database/migrations/
05_m4_part4.sql`) rather than a Mongo result blob, for the same auditability reason (PRD Section 8) every other M4
table is SQL and not Mongo: the acceptance criterion is a ranked, filterable list (`ORDER BY Convergence_Score`,
`WHERE Is_Converging`), which is an indexed query, not a blob read. `(Topic_A_ID, Topic_B_ID)` uses the same
canonical low/high ordering as `COLLABORATION` so a pair is never stored or counted twice under both orderings.

**Method.** `graph/convergence_core.py` deliberately does **not** re-derive a second growth-rate formula. F5's
question ("has this pair's co-occurrence been increasing") is structurally F3's question one level up (single-topic
paper count -> topic-pair co-occurrence count), so it imports Part 2's `compute_growth_rate` (same clamp, same
`NUMERIC(6,4)` cap) instead of duplicating it, and reuses `EMERGING_THRESHOLD`'s value (+30% YoY) as
`CONVERGING_THRESHOLD` for the same reason — two independently-tuned "is this growing fast enough" bars would be
harder to justify to an evaluator than one. `MIN_COOCCURRENCE_FOR_TREND` (default 3) mirrors `trend_core`'s own
`MIN_PAPERS_FOR_TREND` floor: a pair's count has to clear it in the *current* period before a growth swing counts
for anything, same reasoning as Part 2 (a 1-to-2-paper jump is 100% and noise, not signal). `Convergence_Score`
currently mirrors `growth_rate` — `trend_core`'s own docstring flagged this column as something Part 4 "will likely
want its own scale for"; kept equal to `growth_rate` in 4a for consistency with what "Score" already means
everywhere else in the trend system, not because a different formula wasn't considered (see Known limits).

**API contract this sets up for Part 4b:** `canonical_pair(a, b)` (raises on a self-pair — a topic cannot converge
with itself) and `classify_pair_series(cooccurrence_by_year)` are the two entry points Part 4b's Postgres runner
will call once per pair, the same way `graph.trends` calls `trend_core.classify_series` once per topic.

**Verification status.** `pytest tests/test_convergence_core.py` — 15/15 pass, no database required (see the file
itself for the case list: threshold boundaries, the debut-pair/gap-year prior lookups, the growth-rate cap, and one
test asserting the pair formula's output matches `trend_core.classify_trend`'s directly for the same numbers, which
is what "imported, not duplicated" is meant to guarantee).

**Known limits (carried into Part 4b's scope, not fixed here).**
- **"Previously separate" isn't enforced.** A pair that has always co-occurred on nearly every paper either topic
  appears on (near-synonyms, or a topic and an obvious sub-topic of it) can still classify as `Converging` if its
  raw count happens to clear the threshold in one period, even though the two were never really separate fields.
  Telling that apart from a genuine convergence needs each topic's own total paper count for the period (from
  `TOPIC_SNAPSHOT`) to compute an overlap share — this pure module has no database connection to look that up, so
  it's Part 4b's job.
- **`Converging` on `RESEARCH_TREND` is not written yet.** *(Resolved in Part 4b: promotion only replaces `Stable`.)* The schema `CHECK` already allows it (Part 2's own
  docstring calls it out), and `TOPIC_PAIR_TREND` is where 4a stops; Part 4b decides how a pair's convergence
  promotes to a label on each of its two topics' own trend rows without clobbering a real `Emerging`/`Declining`
  classification from Part 2's own run.
- Not run against live Postgres yet *(resolved: Part 4b's suite runs against real PostgreSQL 16)* (no live instance in this sandbox, same constraint noted for Parts 1-3 at the
  bottom of this file) — nothing here needs one, since 4a is pure logic, but Part 4b's persistence/API layer will
  need the same real-Postgres pass Parts 1-3 got before it can claim the same verification status.

## M4 — Part 4b: Topic convergence — persistence and API (F5)

```
backend/graph/convergence.py         Runs 4a's logic against Postgres: TOPIC_PAIR_TREND, Converging promotion, Mongo snapshot
backend/app/routers/topics.py        GET /topics/converging, /topics/pairs/{a}/{b}/trend
backend/tests/test_convergence.py    Persistence, replace semantics, promotion rule, API (real Postgres)
```

```bash
docker compose exec backend python -m graph.convergence            # count pairs, classify, store, promote
docker compose exec backend python -m graph.convergence --dry-run  # the same inside a rolled-back transaction
```

Runs at the end of `run_ingestion` and `seed_dev`, **after `graph.trends`**. Promotion edits Part 2's rows, and a later
`graph.trends` re-run resets them, so re-run this module after it.

- *Counting:* per year, every unordered pair of topics on the same paper (relevance ≥ the same 0.3 floor as Parts 1-2)
  adds 1. Each paper's pairs come from its most relevant topics only (`--max-topics-per-paper`), a guard against
  C(k,2) blow-up. `papers_truncated` in the summary says how often that guard actually cut anything.
- *Classification:* `convergence_core.classify_pair_series`, meaning +30% year over year with at least 3 shared papers
  in the year. `Algorithm` = `cooccurrence_growth(conv=0.3,min=3)`.
- *Promotion:* a topic in at least one converging pair that year gets `Trend_Label = 'Converging'`, but only where
  it was `Stable`. `Emerging`/`Declining` are more specific and are never overwritten.
- *Run semantics:* `TOPIC_PAIR_TREND` is replaced wholesale, and the replace and the promotion happen in one
  transaction. The Mongo summary is `graph_snapshot` / `_id: "convergence"`.

| Endpoint | Notes |
|---|---|
| `/topics/converging?year=` | converging pairs for a year (default: the latest year with any), by `Convergence_Score` |
| `/topics/pairs/{a}/{b}/trend` | the pair's full year-by-year co-occurrence history with its `algorithm` (gap G3) |

The "previously separate" limitation from 4a stands, and the UI states it in every Method disclosure on `/connections`.
The board reads the run's algorithm string from `/meta/runs`.

## Known limits (whole project)

- **Not run against live APIs or a real MongoDB.** The sandbox this was built in could reach neither
  OpenAlex/Semantic Scholar nor a `mongod`. Postgres paths (including the M3 Part 2 graph construction
  above, which uncovered the `numpy.float64` bug fixed in Part 1) are now tested for real against a live
  PostgreSQL instance; the Mongo `$text` query, the `references.*` fields on Semantic Scholar's *search*
  endpoint, and the adapters generally are reviewed but still unverified against a real `mongod`. Smoke
  test first:
  `python -m ingestion.run_ingestion --topic "federated learning" --limit 5 --source semantic_scholar`,
  then check `SELECT count(*) FROM citation;`. M4 Part 3 (`graph.influence`) is likewise verified only
  against a live PostgreSQL 16 instance with Mongo stood in for by `mongomock`, same as Parts 1/2.
- **`AUTHOR_INSTITUTION` is per (author, year), not per paper**, so an author with two affiliations
  in one year is attributed to both on that year's papers via that table (it's kept as-is — see
  "M4 — Pre-work" below). `PAPER_AUTHOR_INSTITUTION` now gives the exact per-paper affiliation and
  is what `v_paper_institution`, search facets, institution pages, `derive_collaboration` and the
  institutional-collaboration graph signal all read.
- Cross-source author identity is only resolved through shared papers. Two records of the same person
  that never share a paper stay separate. This favours "too many authors" over "wrong merges".
- Paper fuzzy matching still loads every existing title per new paper (O(n²)); fine for a class-sized
  corpus, worth an indexed `pg_trgm` lookup if you scale up.
- Screenshots and a browser audit of every route now exist: see `docs/evidence/README.md`. The Mongo
  `$text` channel runs against a real `mongod` in the compose stack. The pytest suite still stands it in
  with mongomock.
- On the paper page, each provenance row's record ID links to that source's own record page (OpenAlex or
  Semantic Scholar), where the original paper can be read. Links on the synthetic dev corpus point at made-up
  IDs; they resolve for really ingested papers.
