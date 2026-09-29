-- ResearchGraph — M4 pre-work: per-paper author/institution attribution
-- Idempotent: safe to re-run against an existing M1+M2 database.
--   docker compose exec -T postgres psql -U researchgraph -d researchgraph < database/migrations/03_m4.sql
-- On a fresh volume docker-compose applies it automatically after 01_schema.sql / 02_m2.sql.

-- ------------------------------------------------------------
-- PAPER_AUTHOR_INSTITUTION (README "Known limits": AUTHOR_INSTITUTION is
-- keyed per (author, year), so an author with two affiliations in one year
-- was credited with both on every paper they wrote that year. This table
-- records the affiliation actually attached to each authorship, which is
-- what the loader already receives per paper (loader.py, load_papers) but
-- previously discarded down to the coarser per-year grain.
--
-- Composite FK to AUTHORSHIP(Paper_ID, Author_ID) means a row here can only
-- ever point at an authorship that exists — an author can't be linked to a
-- paper they didn't write.
--
-- AUTHOR_INSTITUTION is kept as-is: it's the PRD baseline table and still
-- gives per-author affiliation history independent of any one paper. This
-- table will partly duplicate it.
--
-- Coverage note: Semantic Scholar authorships carry no institutions, so
-- only OpenAlex-sourced papers get rows here — same coverage AUTHOR_INSTITUTION
-- already has.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PAPER_AUTHOR_INSTITUTION (
    Paper_ID         INTEGER NOT NULL,
    Author_ID        INTEGER NOT NULL,
    Institution_ID   INTEGER NOT NULL REFERENCES INSTITUTION(Institution_ID) ON DELETE CASCADE,
    PRIMARY KEY (Paper_ID, Author_ID, Institution_ID),
    CONSTRAINT fk_pai_authorship FOREIGN KEY (Paper_ID, Author_ID)
        REFERENCES AUTHORSHIP (Paper_ID, Author_ID) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pai_institution ON PAPER_AUTHOR_INSTITUTION (Institution_ID);
CREATE INDEX IF NOT EXISTS idx_pai_author       ON PAPER_AUTHOR_INSTITUTION (Author_ID);

-- ------------------------------------------------------------
-- v_paper_institution (originally defined in 02_m2.sql) now reads the exact
-- per-paper attribution instead of joining AUTHOR_INSTITUTION on
-- (author, publication year) — no more crediting a paper to an institution
-- the author only held in a *different* paper that same year. Every reader
-- of the view (search facets, institution pages, derive_collaboration) picks
-- this up with no other changes.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_paper_institution AS
SELECT DISTINCT Paper_ID, Institution_ID
FROM PAPER_AUTHOR_INSTITUTION;
