# Product Requirements Document: ResearchGraph

**A Database-Driven System for Discovering Hidden Research Communities and Emerging Research Topics**

| | |
|---|---|
| **Status** | Draft v1.1 |
| **Owner** | Suraj |
| **Source** | Adapted from ResearchGraph Project Proposal |
| **Type** | Academic DBMS project (evaluation deliverable) |
| **Team size** | 3 |
| **Deployment** | Docker Compose (local/self-hosted) |

---

## 1. Summary

ResearchGraph is a web application that turns scattered academic-paper metadata into a connected, temporal graph of authors, institutions, topics, venues, and citations — so users can answer structural questions (who's forming a community, what's emerging, who bridges two fields) that keyword-search tools like Google Scholar or Semantic Scholar cannot answer directly.

The system is database-first: a normalized relational schema (PostgreSQL/MySQL) for structured entities and relationships, paired with MongoDB for flexible metadata (abstracts, embeddings, NLP output, snapshot analytics). Graph algorithms and lightweight NLP sit on top to produce community detection, emerging-topic scoring, bridge-researcher identification, and topic-convergence signals, all surfaced through an interactive dashboard.

---

## 2. Problem Statement

Existing academic search tools are optimized for retrieval — "find papers like this one." They do not expose:

- Which research communities are forming around a topic
- Which researchers or institutions are emerging vs. stagnant
- Which institutions collaborate closely
- Which topics are converging (previously separate fields starting to overlap)
- Which individual researchers act as bridges between communities
- How a field's structure has changed over time

Answering these requires modeling research as a **connected, time-aware graph**, not a flat document index — which in turn requires disciplined relational + non-relational data management, not ad hoc JSON dumps.

---

## 3. Goals & Non-Goals

### Goals
- G1 — Ingest and normalize open scholarly metadata (papers, authors, institutions, topics, venues, citations) into a 3NF relational schema.
- G2 — Store flexible/unstructured metadata (abstracts, NLP output, embeddings, snapshots) in MongoDB, integrated meaningfully (not as a dumping ground).
- G3 — Extract topics from titles/abstracts via NLP and attach them to papers with a relevance score.
- G4 — Construct a graph (Author–Paper–Institution–Topic–Venue–Citation) and run community detection, centrality, and link-prediction algorithms on it.
- G5 — Detect emerging topics via year-over-year growth in publications, citations, authors, and institutions.
- G6 — Identify bridge researchers connecting otherwise-separate communities.
- G7 — Detect topic convergence (previously separate topics increasingly co-occurring).
- G8 — Present all of the above through an interactive dashboard driven by a topic search.
- G9 — Demonstrate core DBMS competencies: normalization, DDL/DML, joins, aggregation, recursive queries, indexing, and basic security (auth, input validation, SQL-injection protection).

### Non-Goals (v1)
- Not a paper-recommendation engine (recommendation-by-similarity is explicitly out of scope; relationship/trend analysis is the focus).
- Not a real-time ingestion pipeline — batch/periodic refresh from the data source is sufficient for v1.
- Not building a proprietary citation index — relies on existing open scholarly data sources.
- No mobile app; web dashboard only.
- No cloud deployment in v1 — Docker Compose (local/self-hosted) is the target, not managed cloud infra.
- LLM-based explanation layers are optional/stretch, not core (per proposal: "the LLM, if used at all, would only be an optional explanation layer").

---

## 4. Users & Use Cases

| User | Need |
|---|---|
| Researcher / grad student | Understand the sub-communities and key players within a topic before starting new work |
| Research supervisor / PI | Spot emerging subfields worth pursuing; identify potential collaborators |
| Institution / research office | See which institutions are collaborating with whom, and where influence is concentrated |
| Evaluator / grader (academic context) | Verify DBMS design rigor: schema, normalization, query complexity, SQL+NoSQL justification |

**Primary use case (from proposal):** A user searches "Federated Learning" and receives: related papers, key authors/institutions/venues, detected sub-communities (e.g., FL+Privacy, FL+Healthcare, FL+Edge Computing), emerging-topic signals, and bridge researchers — plus how all of this changed over time.

---

## 5. Functional Requirements

### F1 — Research Topic Exploration
- User enters a topic (free text, matched against `TOPIC.Topic_Name` and/or embeddings).
- System returns: related papers, top authors, institutions, venues, related/child topics, and citation relationships.
- **Acceptance criteria:** query returns results in a single dashboard view within acceptable latency (see NFRs); results are paginated/ranked by relevance and/or citation count.

### F2 — Research Community Detection
- Build a graph with edges: co-authorship (via `AUTHORSHIP`), citation (`CITATION`), shared-topic (`PAPER_TOPIC`), institutional collaboration (`COLLABORATION`).
- Run a community-detection algorithm (e.g., Louvain) to surface clusters (e.g., "Federated Learning + Privacy").
- Persist results to `RESEARCH_COMMUNITY` / `COMMUNITY_MEMBER`.
- **Acceptance criteria:** for a searched topic, at least the top N communities are shown with member authors and a human-readable label (derived from dominant sub-topics).

### F3 — Emerging Topic Detection
- Compute yearly aggregates per topic (`TOPIC_SNAPSHOT`): paper count, author count, citation count, growth rate.
- Classify each topic per period as `Emerging / Stable / Declining / Converging` (`RESEARCH_TREND`).
- **Acceptance criteria:** dashboard shows a topic-over-time chart and a trend label backed by a defined, documented growth-rate threshold/formula.

### F4 — Researcher Influence & Bridge Detection
- Compute degree centrality, betweenness centrality, PageRank, and a community-bridge score per author on the constructed graph.
- Surface top "bridge" researchers connecting ≥2 distinct communities.
- **Acceptance criteria:** for a searched topic, the system lists researchers who publish across the topic's detected communities, ranked by bridge score.

### F5 — Topic Convergence Detection
- Detect topic pairs whose co-occurrence in `PAPER_TOPIC` has been increasing over recent periods.
- **Acceptance criteria:** system surfaces a ranked list of converging topic pairs (e.g., "AI + Healthcare") with a trend indicator.

### F6 — Dashboard
- Interactive views: community graph, emerging-topic charts, top institutions, influential researchers, citation network, topic growth over time, interdisciplinary connections.
- **Acceptance criteria:** every feature (F1–F5) has a corresponding visual surface; graph views are explorable (zoom/click into a node).

---

## 6. System Architecture

```
Open Research Data (OpenAlex + Semantic Scholar)
        ↓
  Data Collection (per-source adapters → common ingestion format)
        ↓
  Data Cleaning (cross-source dedupe, entity resolution, validate authors/citations)
        ↓
   ┌─────────────┬──────────────┐
   │  SQL (RDBMS)│   MongoDB     │
   └─────────────┴──────────────┘
        ↓
  NLP Topic Extraction
        ↓
  Graph Construction
        ↓
  Graph Algorithms (community detection, centrality, link prediction)
        ↓
  Trend & Community Detection (temporal analysis)
        ↓
  Interactive Dashboard
```

### 6.1 Tech Stack
- **Frontend:** React, TypeScript, Tailwind CSS
- **Backend:** Python, FastAPI
- **Relational DB:** PostgreSQL (or MySQL)
- **Document store:** MongoDB
- **NLP/graph:** Python (e.g., TF-IDF/embeddings for topic extraction; NetworkX or similar for graph algorithms — to be finalized in design phase)
- **Data sources:** OpenAlex and Semantic Scholar (multi-source ingestion) — see 6.2
- **Deployment:** Docker Compose orchestrating frontend, backend, PostgreSQL, and MongoDB as separate services

### 6.2 Multi-source ingestion
Since the system pulls from more than one scholarly data source — **OpenAlex** and **Semantic Scholar** — the ingestion layer is built as **per-source adapters** that normalize each API's response into a common intermediate schema before it touches PostgreSQL/MongoDB. This adds concerns beyond a single-source design:

- **Entity resolution across sources:** the same paper, author, or institution may appear differently in each source (different IDs, name variants). Use external identifiers where available as the primary merge key — DOI for papers (both APIs expose it), ORCID for authors where present, and each source's own native ID as a secondary key — falling back to fuzzy title/name matching with a manual-review queue for low-confidence matches.
- **Provenance tracking:** store which source(s) contributed to each record (e.g., a `Source` field or a join table `PAPER_SOURCE(Paper_ID, Source_Name, Source_Record_ID)`) so conflicting data (e.g., differing citation counts between OpenAlex and Semantic Scholar) can be reconciled or shown with attribution.

**Source-specific notes:**
- **OpenAlex:** no API key required, generous rate limits, strong institution/affiliation data (ROR IDs) — a good primary source for `INSTITUTION` and `AUTHOR_INSTITUTION`.
- **Semantic Scholar:** requires an API key for higher rate limits, has richer citation-context data and its own paper embeddings (SPECTER), which can shortcut part of the topic-extraction/NLP work in F1/F3 instead of computing fresh embeddings from scratch.
- Where both sources return conflicting citation counts or abstracts for the same paper (matched by DOI), prefer Semantic Scholar's citation-context richness but fall back to OpenAlex when a DOI is missing or Semantic Scholar coverage is thin for that venue.

### 6.3 Docker Compose layout (planned services)
| Service | Purpose |
|---|---|
| `frontend` | React/TypeScript dashboard |
| `backend` | FastAPI app (REST API, ingestion orchestration, graph/NLP jobs) |
| `postgres` | Relational store |
| `mongo` | Document store |
| `ingestion` (optional separate service or backend job) | Scheduled/triggered pulls from OpenAlex and Semantic Scholar |

Each service gets its own container with environment-variable-based configuration (DB credentials, Semantic Scholar API key) — no secrets hardcoded, consistent with the security requirements in Section 8.

### 6.4 SQL ↔ MongoDB division of responsibility
| Store | Holds |
|---|---|
| PostgreSQL/MySQL | Author, Paper, Institution, Topic, Venue, Citation, Authorship, PaperTopic, Community, Trend tables — anything relational/structured needing joins, integrity, aggregation |
| MongoDB | Abstracts, raw API responses, NLP-extracted keywords, topic embeddings, yearly snapshots, graph-analysis result blobs — flexible/variable-shape data |

---

## 7. Data Model

### 7.1 Core entities (relational)
`AUTHOR`, `INSTITUTION`, `AUTHOR_INSTITUTION`, `PAPER`, `AUTHORSHIP`, `TOPIC` (self-referencing `Parent_Topic_ID` for hierarchy), `PAPER_TOPIC`, `VENUE`, `CITATION` (recursive PAPER↔PAPER), `RESEARCH_COMMUNITY`, `COMMUNITY_MEMBER`, `TOPIC_SNAPSHOT`, `COLLABORATION`, `RESEARCH_TREND`.

Full column-level schema is defined in the source proposal (Section 8) and should be treated as the v1 schema baseline — normalized to 3NF, with composite primary keys on all junction tables (`AUTHORSHIP`, `PAPER_TOPIC`, `AUTHOR_INSTITUTION`, `COMMUNITY_MEMBER`, `CITATION`).

### 7.2 Key relationships
- AUTHOR **M:N** PAPER via AUTHORSHIP
- AUTHOR **M:N** INSTITUTION via AUTHOR_INSTITUTION
- PAPER **M:N** TOPIC via PAPER_TOPIC
- PAPER **M:N** PAPER (recursive) via CITATION
- VENUE **1:M** PAPER
- TOPIC **1:M** TOPIC_SNAPSHOT
- AUTHOR **M:N** RESEARCH_COMMUNITY via COMMUNITY_MEMBER

### 7.3 MongoDB document shape (example)
```json
{
  "paper_id": 1024,
  "abstract": "...",
  "keywords": ["federated learning", "privacy", "machine learning"],
  "embedding": [0.12, 0.45, 0.78],
  "nlp_status": "processed"
}
```

---

## 8. Non-Functional Requirements

- **Data integrity:** enforce PK/FK constraints; citations must reference existing papers; authorship must reference existing authors and papers.
- **Normalization:** relational schema to 3NF.
- **Performance:** index Paper title, publication year, author name, topic name, and citation join columns; dashboard queries should return within a few seconds for typical topic searches.
- **Security:** authentication, role-based access, parameterized queries (SQL-injection protection), input validation, DB credentials via environment variables — not hardcoded.
- **Auditability:** trend/community detection runs should be timestamped and re-producible (store `Detection_Date`, `Algorithm` used).

---

## 9. Analytics & Query Requirements (representative)

- `Find all authors who published on Federated Learning between 2023–2025, with their institutions.`
- `Find papers that cite papers from a different research community.`
- `Find institutions that collaborated on papers spanning two different topics.`
- Aggregation: `Publication_Year → COUNT(*)` per topic.
- Recursive traversal of citation chains (Paper A → B → C → D).

These should be implemented as SQL views or stored procedures where reused by multiple dashboard features.

---

## 10. Milestones & Suggested Team Split (3 people)

With a 3-person team, a natural split is one person owning data/backend, one owning graph/NLP analytics, and one owning frontend/dashboard — converging at each milestone rather than working in isolation, since the dashboard depends on analytics output which depends on the data layer.

| Phase | Scope | Suggested owner focus |
|---|---|---|
| M1 — Data foundation | Finalize 3NF schema, stand up PostgreSQL + MongoDB (Docker Compose), build per-source ingestion adapters (6.2), load & clean an initial multi-source dataset, resolve entity duplicates | Data/backend |
| M2 — Core relational features | Authors, papers, institutions, topics, venues, citations queryable via FastAPI; basic topic-search dashboard (F1) wired end-to-end | Backend + frontend (parallel) |
| M3 — NLP + graph construction | Topic extraction pipeline, graph construction from relational data, provenance/merge logic validated across sources | Analytics owner |
| M4 — Analytics | Community detection (F2), emerging-topic detection (F3), bridge-researcher detection (F4), convergence detection (F5) | Analytics owner, backend support |
| M5 — Dashboard & polish | Full interactive dashboard (F6), security hardening (auth, input validation), indexing/performance pass, Docker Compose finalized for a clean one-command demo run | Frontend owner, full team |
| M6 — Evaluation prep | Rehearse the demo query set (Section 9), prepare schema/ER walkthrough and normalization justification, confirm SQL+NoSQL split talking points | Full team |

*(No fixed calendar dates assumed — slot these against your actual submission deadline.)*

### 10.1 Academic evaluation alignment
Since this is being built for academic evaluation, keep the deliverable set explicit and demoable:
- A clean **ER diagram** and schema walkthrough (already in Section 7) — be ready to justify normalization decisions (3NF) and every FK.
- A clear **SQL vs. NoSQL rationale** (Section 6.2 of the original proposal / Section 7.3 here) — evaluators will likely probe *why* MongoDB is needed rather than "everything in Postgres."
- A small set of **non-trivial live queries** to run in front of an evaluator: at least one join-heavy query, one aggregation, and one recursive query (Section 9) — rehearse these rather than writing them fresh under pressure.
- A **one-command demo path** (`docker compose up`) so the evaluator can see it running without environment setup friction.

---

## 11. Risks & Open Questions

- **Cross-source entity resolution:** merging the same paper/author/institution across multiple APIs is the highest-risk piece of the whole system — incomplete disambiguation (e.g., differing author IDs) directly corrupts graph accuracy. Budget real time for this in M1, not just a naive DOI match.
- **Topic extraction quality:** TF-IDF/embedding-based extraction may need tuning; naive keyword extraction can misclassify interdisciplinary papers.
- **Community-detection interpretability:** Louvain-style clusters need a labeling strategy (e.g., dominant topic terms) to be meaningful to evaluators, not just a cluster ID.
- **Scale vs. deadline:** citation graphs can grow large quickly — for an academic timeline, scope the demo dataset to a small set of topics (e.g., Federated Learning + 2–3 adjacent areas) rather than attempting the full research ecosystem.
- **Docker Compose resource use:** running Postgres + MongoDB + backend + frontend together locally needs enough RAM on dev/demo machines — worth confirming early rather than discovering it at demo time.
- **Semantic Scholar rate limits:** the unauthenticated tier is quite restrictive — request an API key early so ingestion isn't bottlenecked close to the deadline.

---

## 12. Success Metrics

- All 6 functional requirements (F1–F6) demonstrable end-to-end on a real dataset subset (e.g., "Federated Learning" corpus).
- Schema passes 3NF review with justified SQL/NoSQL split.
- At least 3 non-trivial SQL queries (joins, aggregation, recursive) demonstrated live.
- Dashboard usable without prior explanation (basic usability bar).
