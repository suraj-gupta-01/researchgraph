-- ResearchGraph — M4 Part 3: researcher influence & bridge detection (F4)
-- Idempotent: safe to re-run against an existing M1+M2+M4(pre-work/Part1/2) database.
--   docker compose exec -T postgres psql -U researchgraph -d researchgraph < database/migrations/04_m4_part3.sql
-- On a fresh volume docker-compose applies it automatically after 01_schema.sql / 02_m2.sql / 03_m4.sql.

-- ------------------------------------------------------------
-- AUTHOR_INFLUENCE (README "M4 -- Part 3"): one row per author, holding the
-- four F4 metrics computed on the author-collaboration graph (the same graph
-- graph.communities partitions in Part 1):
--   Degree_Centrality       structural degree / (n-1), unweighted (PRD says
--                           "degree centrality" plainly; the weighted variant
--                           is a different, documented choice -- see
--                           graph/influence_core.py)
--   Betweenness_Centrality  weighted, computed on inverted-weight distances
--                           (strength -> distance) so a shortest path prefers
--                           strong ties, not weak ones
--   Pagerank                weighted, weight used as-is (higher tie strength
--                           = more importance transferred, PageRank's normal
--                           reading of a weight)
--   Bridge_Score            participation coefficient (Guimera & Amaral 2005)
--                           over the author's ties into RESEARCH_COMMUNITY /
--                           COMMUNITY_MEMBER assignments: 0 when every tie
--                           stays inside one community (or the author has no
--                           ties into any community), approaching 1 the more
--                           evenly ties spread across many communities.
--   Communities_Touched     how many distinct communities the bridge score
--                           was computed over -- the PRD's own bar ("bridge
--                           researchers connecting >= 2 distinct
--                           communities") is Communities_Touched >= 2, kept as
--                           a stored column rather than recomputed by every
--                           reader.
--
-- Like RESEARCH_COMMUNITY/TOPIC_SNAPSHOT, a run REPLACES the full table
-- (graph.influence's own job), not one row at a time, so Postgres always
-- holds exactly one, current, consistent set (PRD Section 8, auditability).
-- Author_ID is the primary key -- unlike RESEARCH_COMMUNITY (which gets new
-- surrogate ids every run because membership can change), an author's
-- influence row is inherently one-per-author, so an upsert-shaped replace
-- (delete-all, reinsert) needs no surrogate key of its own.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS AUTHOR_INFLUENCE (
    Author_ID              INTEGER PRIMARY KEY REFERENCES AUTHOR(Author_ID) ON DELETE CASCADE,
    Degree_Centrality      NUMERIC(7,6) NOT NULL CHECK (Degree_Centrality BETWEEN 0 AND 1),
    Betweenness_Centrality NUMERIC(7,6) NOT NULL CHECK (Betweenness_Centrality BETWEEN 0 AND 1),
    Pagerank               NUMERIC(9,8) NOT NULL CHECK (Pagerank BETWEEN 0 AND 1),
    Bridge_Score           NUMERIC(7,6) NOT NULL CHECK (Bridge_Score BETWEEN 0 AND 1),
    Communities_Touched    SMALLINT NOT NULL DEFAULT 0 CHECK (Communities_Touched >= 0),
    Detection_Date         TIMESTAMPTZ NOT NULL DEFAULT now(),
    Algorithm              VARCHAR(50) NOT NULL
);

-- Bridge-researcher listing (F4 acceptance: "ranked by bridge score") and the
-- >= 2 community floor both filter/sort on these together.
CREATE INDEX IF NOT EXISTS idx_author_influence_bridge
    ON AUTHOR_INFLUENCE (Communities_Touched DESC, Bridge_Score DESC);

-- ------------------------------------------------------------
-- AUTHOR_COMMUNITY_TIE: per (author, community) weighted tie strength behind
-- each author's bridge score -- the evidence for *why* an author bridges the
-- communities it does, the same role graph_snapshot's community "topics"
-- evidence plays for labels, but small and structured enough to live in
-- Postgres rather than only in a Mongo blob (it is joined against
-- RESEARCH_COMMUNITY/AUTHOR for the detail endpoint). Replaced in full
-- alongside AUTHOR_INFLUENCE on every run.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS AUTHOR_COMMUNITY_TIE (
    Author_ID       INTEGER NOT NULL REFERENCES AUTHOR(Author_ID) ON DELETE CASCADE,
    Community_ID    INTEGER NOT NULL REFERENCES RESEARCH_COMMUNITY(Community_ID) ON DELETE CASCADE,
    Tie_Weight      NUMERIC(10,4) NOT NULL CHECK (Tie_Weight > 0),
    Tie_Share       NUMERIC(6,5) NOT NULL CHECK (Tie_Share BETWEEN 0 AND 1),
    PRIMARY KEY (Author_ID, Community_ID)
);

CREATE INDEX IF NOT EXISTS idx_author_community_tie_community ON AUTHOR_COMMUNITY_TIE (Community_ID);
