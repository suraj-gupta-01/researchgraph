-- ResearchGraph — Relational Schema (PostgreSQL)
-- Milestone: M1 — Data foundation
-- Normalized to 3NF. Composite PKs on all junction tables.
-- Multi-source provenance handled via PAPER_SOURCE / AUTHOR_SOURCE rather than
-- baking source-specific columns into the core entities.

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy title/name matching support (entity resolution)
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive text (emails, DOIs)

-- ============================================================
-- CORE ENTITIES
-- ============================================================

CREATE TABLE VENUE (
    Venue_ID        SERIAL PRIMARY KEY,
    Venue_Name      TEXT NOT NULL,
    Venue_Type      VARCHAR(30),           -- journal / conference / preprint / workshop
    Publisher       TEXT,
    ISSN            VARCHAR(20),
    UNIQUE (Venue_Name, Venue_Type)
);

CREATE TABLE INSTITUTION (
    Institution_ID   SERIAL PRIMARY KEY,
    Institution_Name TEXT NOT NULL,
    Country          VARCHAR(100),
    ROR_ID           VARCHAR(50) UNIQUE,   -- OpenAlex-native identifier, best merge key for institutions
    UNIQUE (Institution_Name, Country)
);

CREATE TABLE AUTHOR (
    Author_ID        SERIAL PRIMARY KEY,
    Full_Name        TEXT NOT NULL,
    ORCID            VARCHAR(25) UNIQUE,   -- primary cross-source merge key when present
    Openalex_Author_ID   VARCHAR(50) UNIQUE,
    Semantic_Scholar_Author_ID VARCHAR(50) UNIQUE
);

CREATE TABLE AUTHOR_INSTITUTION (
    Author_ID        INTEGER NOT NULL REFERENCES AUTHOR(Author_ID) ON DELETE CASCADE,
    Institution_ID   INTEGER NOT NULL REFERENCES INSTITUTION(Institution_ID) ON DELETE CASCADE,
    Start_Year       SMALLINT,
    End_Year         SMALLINT,             -- NULL = current affiliation
    PRIMARY KEY (Author_ID, Institution_ID, Start_Year)
);

CREATE TABLE TOPIC (
    Topic_ID         SERIAL PRIMARY KEY,
    Topic_Name       TEXT NOT NULL UNIQUE,
    Parent_Topic_ID  INTEGER REFERENCES TOPIC(Topic_ID) ON DELETE SET NULL,  -- self-referencing hierarchy
    Description      TEXT
);

CREATE TABLE PAPER (
    Paper_ID         SERIAL PRIMARY KEY,
    Title            TEXT NOT NULL,
    DOI              VARCHAR(255) UNIQUE,   -- primary cross-source merge key for papers
    Publication_Year SMALLINT NOT NULL,
    Venue_ID         INTEGER REFERENCES VENUE(Venue_ID) ON DELETE SET NULL,
    Citation_Count   INTEGER DEFAULT 0,     -- cached/reconciled count; source-level counts live in PAPER_SOURCE
    Openalex_Paper_ID VARCHAR(50) UNIQUE,
    Semantic_Scholar_Paper_ID VARCHAR(50) UNIQUE
);

CREATE TABLE AUTHORSHIP (
    Author_ID        INTEGER NOT NULL REFERENCES AUTHOR(Author_ID) ON DELETE CASCADE,
    Paper_ID         INTEGER NOT NULL REFERENCES PAPER(Paper_ID) ON DELETE CASCADE,
    Author_Position  SMALLINT,              -- 1 = first author, etc.
    Is_Corresponding BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (Author_ID, Paper_ID)
);

CREATE TABLE PAPER_TOPIC (
    Paper_ID         INTEGER NOT NULL REFERENCES PAPER(Paper_ID) ON DELETE CASCADE,
    Topic_ID         INTEGER NOT NULL REFERENCES TOPIC(Topic_ID) ON DELETE CASCADE,
    Relevance_Score  NUMERIC(5,4) NOT NULL CHECK (Relevance_Score BETWEEN 0 AND 1),
    Extraction_Method VARCHAR(30),          -- e.g. 'tfidf', 'embedding', 'semantic_scholar_field'
    PRIMARY KEY (Paper_ID, Topic_ID)
);

-- Recursive PAPER <-> PAPER relationship (citing paper cites cited paper)
CREATE TABLE CITATION (
    Citing_Paper_ID  INTEGER NOT NULL REFERENCES PAPER(Paper_ID) ON DELETE CASCADE,
    Cited_Paper_ID   INTEGER NOT NULL REFERENCES PAPER(Paper_ID) ON DELETE CASCADE,
    Context          TEXT,                  -- citation-context snippet if available (Semantic Scholar)
    PRIMARY KEY (Citing_Paper_ID, Cited_Paper_ID),
    CHECK (Citing_Paper_ID <> Cited_Paper_ID)
);

CREATE TABLE COLLABORATION (
    Institution_A_ID INTEGER NOT NULL REFERENCES INSTITUTION(Institution_ID) ON DELETE CASCADE,
    Institution_B_ID INTEGER NOT NULL REFERENCES INSTITUTION(Institution_ID) ON DELETE CASCADE,
    Paper_ID         INTEGER NOT NULL REFERENCES PAPER(Paper_ID) ON DELETE CASCADE,
    PRIMARY KEY (Institution_A_ID, Institution_B_ID, Paper_ID),
    CHECK (Institution_A_ID < Institution_B_ID)   -- canonical ordering, avoids duplicate (A,B)/(B,A) rows
);

-- ============================================================
-- DERIVED / ANALYTICS ENTITIES (populated by M3-M4 jobs, schema is M1)
-- ============================================================

CREATE TABLE RESEARCH_COMMUNITY (
    Community_ID     SERIAL PRIMARY KEY,
    Label            TEXT,                  -- derived from dominant sub-topics, e.g. "FL + Privacy"
    Root_Topic_ID    INTEGER REFERENCES TOPIC(Topic_ID) ON DELETE SET NULL,
    Detection_Date   TIMESTAMPTZ NOT NULL DEFAULT now(),
    Algorithm        VARCHAR(50) NOT NULL   -- e.g. 'louvain'
);

CREATE TABLE COMMUNITY_MEMBER (
    Community_ID     INTEGER NOT NULL REFERENCES RESEARCH_COMMUNITY(Community_ID) ON DELETE CASCADE,
    Author_ID        INTEGER NOT NULL REFERENCES AUTHOR(Author_ID) ON DELETE CASCADE,
    Membership_Score NUMERIC(5,4),
    PRIMARY KEY (Community_ID, Author_ID)
);

CREATE TABLE TOPIC_SNAPSHOT (
    Topic_ID         INTEGER NOT NULL REFERENCES TOPIC(Topic_ID) ON DELETE CASCADE,
    Snapshot_Year    SMALLINT NOT NULL,
    Paper_Count      INTEGER NOT NULL DEFAULT 0,
    Author_Count     INTEGER NOT NULL DEFAULT 0,
    Institution_Count INTEGER NOT NULL DEFAULT 0,
    Citation_Count   INTEGER NOT NULL DEFAULT 0,
    Growth_Rate      NUMERIC(6,4),          -- YoY growth vs previous Snapshot_Year, defined formula in F3
    PRIMARY KEY (Topic_ID, Snapshot_Year)
);

CREATE TABLE RESEARCH_TREND (
    Topic_ID         INTEGER NOT NULL REFERENCES TOPIC(Topic_ID) ON DELETE CASCADE,
    Period_Year      SMALLINT NOT NULL,
    Trend_Label      VARCHAR(20) NOT NULL CHECK (Trend_Label IN ('Emerging','Stable','Declining','Converging')),
    Score            NUMERIC(6,4),
    Detection_Date   TIMESTAMPTZ NOT NULL DEFAULT now(),
    Algorithm        VARCHAR(50) NOT NULL,
    PRIMARY KEY (Topic_ID, Period_Year)
);

-- ============================================================
-- PROVENANCE (multi-source ingestion, Section 6.2)
-- ============================================================

CREATE TABLE PAPER_SOURCE (
    Paper_ID         INTEGER NOT NULL REFERENCES PAPER(Paper_ID) ON DELETE CASCADE,
    Source_Name      VARCHAR(30) NOT NULL CHECK (Source_Name IN ('openalex','semantic_scholar')),
    Source_Record_ID VARCHAR(100) NOT NULL,
    Source_Citation_Count INTEGER,
    Fetched_At       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (Paper_ID, Source_Name)
);

CREATE TABLE ENTITY_RESOLUTION_QUEUE (
    Queue_ID         SERIAL PRIMARY KEY,
    Entity_Type      VARCHAR(20) NOT NULL CHECK (Entity_Type IN ('paper','author','institution')),
    Candidate_A      JSONB NOT NULL,        -- normalized record from source A
    Candidate_B      JSONB NOT NULL,        -- normalized record from source B
    Match_Confidence NUMERIC(5,4),
    Status           VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending','merged','rejected')),
    Created_At       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- INDEXES (per NFR: title, publication year, author name, topic name, citation joins)
-- ============================================================

CREATE INDEX idx_paper_title_trgm ON PAPER USING gin (Title gin_trgm_ops);
CREATE INDEX idx_paper_pub_year   ON PAPER (Publication_Year);
CREATE INDEX idx_author_name_trgm ON AUTHOR USING gin (Full_Name gin_trgm_ops);
CREATE INDEX idx_topic_name       ON TOPIC (Topic_Name);
CREATE INDEX idx_citation_citing  ON CITATION (Citing_Paper_ID);
CREATE INDEX idx_citation_cited   ON CITATION (Cited_Paper_ID);
CREATE INDEX idx_authorship_paper ON AUTHORSHIP (Paper_ID);
CREATE INDEX idx_authorship_author ON AUTHORSHIP (Author_ID);
CREATE INDEX idx_papertopic_topic ON PAPER_TOPIC (Topic_ID);
CREATE INDEX idx_snapshot_year    ON TOPIC_SNAPSHOT (Snapshot_Year);
