-- ResearchGraph — M4 Part 4a (F5: Topic Convergence Detection)
--
-- Decides the question the README left open under "M4 — Analytics":
-- "RESEARCH_TREND is keyed per topic, but F5 ranks topic *pairs* — either
-- add a small pair table (a migration) or keep pair scores in Mongo as a
-- result blob."
--
-- Decision: a small pair table, TOPIC_PAIR_TREND, for the same reason
-- RESEARCH_COMMUNITY/TOPIC_SNAPSHOT/RESEARCH_TREND/AUTHOR_INFLUENCE are all
-- SQL tables and not Mongo blobs (PRD Section 8, auditability NFR: "trend/
-- community detection runs should be timestamped and reproducible"). A
-- Mongo blob can hold one run's top-N list, but the acceptance criterion
-- ("a ranked list of converging topic pairs... with a trend indicator") is
-- exactly the kind of indexed, filterable, joinable query Postgres is
-- built for (ORDER BY Convergence_Score, WHERE Is_Converging, JOIN back to
-- TOPIC for names) — the same reasoning Part 3 used for
-- AUTHOR_COMMUNITY_TIE over a Mongo evidence blob.

CREATE TABLE TOPIC_PAIR_TREND (
    Topic_A_ID                 INTEGER NOT NULL REFERENCES TOPIC(Topic_ID) ON DELETE CASCADE,
    Topic_B_ID                 INTEGER NOT NULL REFERENCES TOPIC(Topic_ID) ON DELETE CASCADE,
    Period_Year                SMALLINT NOT NULL,
    Cooccurrence_Count         INTEGER NOT NULL,       -- papers tagged with both topics (>= relevance floor) in Period_Year
    Prior_Cooccurrence_Count   INTEGER NOT NULL DEFAULT 0,
    Growth_Rate                NUMERIC(6,4) NOT NULL,  -- same formula/clamp as RESEARCH_TREND.Growth_Rate (graph.trend_core)
    Convergence_Score          NUMERIC(6,4) NOT NULL,  -- see graph.convergence_core; currently mirrors Growth_Rate
    Is_Converging               BOOLEAN NOT NULL DEFAULT FALSE,
    Detection_Date              TIMESTAMPTZ NOT NULL DEFAULT now(),
    Algorithm                   VARCHAR(50) NOT NULL,
    PRIMARY KEY (Topic_A_ID, Topic_B_ID, Period_Year),
    -- Canonical ordering, same device as COLLABORATION.Institution_A_ID <
    -- Institution_B_ID: avoids storing both (A,B) and (B,A) rows for one pair.
    CHECK (Topic_A_ID < Topic_B_ID)
);

-- Ranked-list query (evaluator-facing acceptance criterion): latest period,
-- converging pairs, highest score first.
CREATE INDEX idx_pairtrend_year        ON TOPIC_PAIR_TREND (Period_Year);
CREATE INDEX idx_pairtrend_converging  ON TOPIC_PAIR_TREND (Period_Year, Convergence_Score DESC) WHERE Is_Converging;
