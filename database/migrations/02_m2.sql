-- ResearchGraph — M2 additions (core relational features + F1 search)
-- Idempotent: safe to re-run against an existing M1 database.
--   docker compose exec -T postgres psql -U researchgraph -d researchgraph < database/migrations/02_m2.sql
-- On a fresh volume docker-compose applies it automatically after 01_schema.sql.

-- ------------------------------------------------------------
-- Full-text search on titles (F1). Generated column => always in sync with
-- Title, no trigger to maintain. websearch_to_tsquery gives users quoted
-- phrases / OR / -exclusion for free.
-- ------------------------------------------------------------
ALTER TABLE PAPER
    ADD COLUMN IF NOT EXISTS Title_TSV tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(Title, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_paper_title_tsv ON PAPER USING gin (Title_TSV);

-- ------------------------------------------------------------
-- Supporting indexes for the M2 read paths (FK columns Postgres does not
-- index automatically, sort keys, and ILIKE name search).
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_paper_venue          ON PAPER (Venue_ID);
CREATE INDEX IF NOT EXISTS idx_paper_citation_count ON PAPER (Citation_Count DESC, Paper_ID);
CREATE INDEX IF NOT EXISTS idx_author_inst_inst     ON AUTHOR_INSTITUTION (Institution_ID);
CREATE INDEX IF NOT EXISTS idx_collab_b             ON COLLABORATION (Institution_B_ID);
CREATE INDEX IF NOT EXISTS idx_collab_paper         ON COLLABORATION (Paper_ID);
CREATE INDEX IF NOT EXISTS idx_topic_parent         ON TOPIC (Parent_Topic_ID);
CREATE INDEX IF NOT EXISTS idx_institution_name_trgm ON INSTITUTION USING gin (Institution_Name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_venue_name_trgm       ON VENUE USING gin (Venue_Name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_topic_name_trgm       ON TOPIC USING gin (Topic_Name gin_trgm_ops);

-- ------------------------------------------------------------
-- DOIs are case-insensitive; M1 stored them as received. Lower-case existing
-- rows (skipping any that would collide) so cross-source DOI matching works
-- against data loaded before the adapters normalized them.
-- ------------------------------------------------------------
UPDATE PAPER p
SET DOI = lower(p.DOI)
WHERE p.DOI IS NOT NULL
  AND p.DOI <> lower(p.DOI)
  AND NOT EXISTS (SELECT 1 FROM PAPER q WHERE q.DOI = lower(p.DOI) AND q.Paper_ID <> p.Paper_ID);

-- ------------------------------------------------------------
-- View reused by several features: which institutions a paper is attributed
-- to. AUTHOR_INSTITUTION rows are written with Start_Year = the year of the
-- paper the affiliation was observed on, so joining on
-- (author, publication year) recovers the affiliation as seen on that paper.
-- Used by: search facets, institution pages, COLLABORATION derivation.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_paper_institution AS
SELECT DISTINCT s.Paper_ID, ai.Institution_ID
FROM AUTHORSHIP s
JOIN PAPER p ON p.Paper_ID = s.Paper_ID
JOIN AUTHOR_INSTITUTION ai
  ON ai.Author_ID = s.Author_ID
 AND ai.Start_Year = p.Publication_Year;
