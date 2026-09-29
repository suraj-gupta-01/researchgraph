# Evidence pack (Phase 9 / PRD M6)

What was verified, how, and against what data. Last full run: 2026-09-27.

## Contents

| Path | What |
|---|---|
| `screens/1440/`, `screens/390/` | Full-page screenshot of all 28 routes at desktop and phone width (140-paper dev corpus, production build behind nginx + CSP) |
| `report.json` | Per route and viewport: horizontal overflow, console errors, CSP violations, axe WCAG 2.1 A/AA findings, load time. All 56 entries are clean |
| `perf-3000/browser-report.json` | The same browser pass against a 3,000-paper corpus |
| `perf-3000/api-3000-papers.json`, `api-140-papers.json` | API latency per dashboard endpoint (10 requests each) on both corpora |
| `perf-3000/apibench.py` | The script that produced them: `python apibench.py <api> <origin> 10 out.json` |

Regenerate the browser pass with `cd frontend && npm run e2e` against a running
`docker compose up` stack. Set `E2E_BASE_URL`, `E2E_API_URL` and `E2E_OUT` to
point it at another stack without overwriting this folder.

## Verified live (real browser / real databases)

| Check | Result |
|---|---|
| `docker compose up -d --build`: postgres, mongo, backend, frontend all healthy; `/health` = `{"postgres":"ok","mongo":"ok"}` | pass |
| Backend `pytest` against real PostgreSQL 16 (Mongo via mongomock) | 301 passed, 3 skipped (data-conditional guards, not failures) |
| Frontend `npm run typecheck`, `npm test`, `npm run build` | clean, 256 tests passed, build ok |
| `npm run check:coverage` against the live `/openapi.json` | 40/40 operations have a UI surface or a documented reason |
| Playwright evidence pass, 28 routes × 2 viewports, in Chrome | 0 overflow, 0 console errors, 0 CSP violations, 0 axe findings |
| `/meta/runs` on the demo stack | all 6 analyses `ok`; all 15 provenance checks `pass` |

## Performance at scale (3,000 papers)

Phase 9 asks for a measurement against a corpus of at least a few thousand papers.
It was run on a separate database (`seed_dev --papers 3000`: 4,200 source records,
14,777 authorships, 8,866 citations, 3,481-node / 53,360-edge graph). The whole
ingest-to-analytics pipeline took about 48 s.

**API, median of 10 (140 → 3,000 papers):**

| Endpoint | 140 | 3,000 |
|---|---|---|
| F1 search overview | 22 ms | 107 ms |
| F1 search papers | 13 ms | 77 ms |
| F1/F6 citation network | 31 ms | 75 ms |
| Recursive citation chain, depth 5 | 20 ms | 31 ms |
| F2 community graph | 45 ms | 244 ms |
| F2 communities, scoped | 16 ms | 51 ms |
| F4 bridges, scoped | 13 ms | 49 ms |
| Top institutions by country | 9 ms | 129 ms |
| Section 9 cross-community citations | 23 ms | 63 ms |
| every other endpoint | ≤ 23 ms | ≤ 30 ms |

The slowest endpoint at 3,000 papers is the community graph at 244 ms, well
inside the NFR's "a few seconds".

**Browser, route load to settled page:** the median was 876 ms at 140 papers and
881 ms at 3,000 papers. The worst route was the citation network at 390 px, at
1,247 ms. About 800 ms of every figure is the harness's fixed settle floor
(network idle plus 300 ms), so these are upper bounds.

The one browser finding at 3,000 papers was a `/favicon.ico` 404 on the sign-in
page. It is an artifact of `vite preview`, which that run used in place of nginx.
nginx's SPA fallback answers it, and the nginx pass above has no such error.

### Bugs the scale run found (fixed, with regression tests)

1. **The provenance report could not be saved to MongoDB** whenever a warning
   carried raw SQL rows as examples. SQLAlchemy 2.x `Row` is not a tuple, so it
   was not converted and BSON refused it. The job logged a warning and carried
   on, so `/meta/runs` would keep showing an old report on any real corpus with
   same-name co-authors or forward-in-time citations. The fix is in
   `ingestion/validate_provenance.py::_short`.
2. **The synthetic corpus could produce a negative citation count.** The
   Semantic Scholar count was the OpenAlex count plus noise in [-2, 6], so
   1 − 2 = −1. The provenance check correctly failed on it; the generator was
   wrong. The fix is in `ingestion/seed_dev.py`. The RNG call order is unchanged,
   so the default 140-paper corpus is byte-identical.

## Verified only by tests / review

- The OpenAlex and Semantic Scholar adapters against the live APIs. No network
  run was made in this pass; smoke test with
  `python -m ingestion.run_ingestion --topic "federated learning" --limit 5`.
- The Mongo `$text` channel is exercised by the running stack (real `mongod`),
  but the test suite stands it in with a pure-Python matcher, since mongomock
  has no `$text`.
