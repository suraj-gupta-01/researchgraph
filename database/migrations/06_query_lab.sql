-- ============================================================
-- Phase 9 / M6 (G6): the PRD Section 9 demo queries as reusable SQL
-- objects ("implemented as SQL views or stored procedures where reused").
-- The /queries/* endpoints are thin wrappers over these, and
-- /queries/catalog returns their definitions (pg_get_viewdef /
-- pg_get_functiondef) so the query lab shows exactly what Postgres runs.
-- Idempotent: CREATE OR REPLACE throughout.
-- ============================================================

-- A paper's research community = the majority community of its authors
-- (ties -> lowest Community_ID). There is no per-paper community in the
-- schema, only per-author (COMMUNITY_MEMBER); same rule as
-- /search/citation-network. Papers whose authors are all unassigned have no row.
CREATE OR REPLACE VIEW v_paper_community AS
SELECT DISTINCT ON (s.Paper_ID)
       s.Paper_ID,
       cm.Community_ID,
       COUNT(*) AS member_authors
FROM AUTHORSHIP s
JOIN COMMUNITY_MEMBER cm ON cm.Author_ID = s.Author_ID
GROUP BY s.Paper_ID, cm.Community_ID
ORDER BY s.Paper_ID, COUNT(*) DESC, cm.Community_ID;

-- Section 9: "Find papers that cite papers from a different research community."
CREATE OR REPLACE VIEW v_cross_community_citation AS
SELECT c.Citing_Paper_ID,
       pc_from.Community_ID AS Citing_Community_ID,
       c.Cited_Paper_ID,
       pc_to.Community_ID   AS Cited_Community_ID
FROM CITATION c
JOIN v_paper_community pc_from ON pc_from.Paper_ID = c.Citing_Paper_ID
JOIN v_paper_community pc_to   ON pc_to.Paper_ID   = c.Cited_Paper_ID
WHERE pc_from.Community_ID <> pc_to.Community_ID;

-- Section 9: "Find institutions that collaborated on papers spanning two
-- different topics." One row per collaborating institution pair, per paper,
-- per topic tag on that paper; a caller asks for pairs whose shared paper
-- carries BOTH topics (see /queries/institution-topic-collaboration).
CREATE OR REPLACE VIEW v_institution_topic_collaboration AS
SELECT col.Institution_A_ID,
       col.Institution_B_ID,
       col.Paper_ID,
       pt.Topic_ID,
       pt.Relevance_Score
FROM COLLABORATION col
JOIN PAPER_TOPIC pt ON pt.Paper_ID = col.Paper_ID;

-- Section 9 aggregation: "Publication_Year -> COUNT(*) per topic", computed
-- live from the base tables (TOPIC_SNAPSHOT holds the same numbers as
-- precomputed by graph.trends, with the relevance floor applied there).
CREATE OR REPLACE VIEW v_topic_year_counts AS
SELECT pt.Topic_ID,
       p.Publication_Year,
       COUNT(*)                 AS paper_count,
       SUM(p.Citation_Count)    AS citation_count
FROM PAPER_TOPIC pt
JOIN PAPER p ON p.Paper_ID = pt.Paper_ID
GROUP BY pt.Topic_ID, p.Publication_Year;

-- Section 9: "Find all authors who published on <topic> between <years>,
-- with their institutions." A stored function (parameterized, so not a
-- view): topic descendants included via a recursive walk of
-- TOPIC.Parent_Topic_ID, institutions from the per-paper attribution table.
CREATE OR REPLACE FUNCTION fn_topic_authors(
    p_topic_id INTEGER,
    p_year_from INTEGER,
    p_year_to INTEGER,
    p_min_relevance NUMERIC DEFAULT 0.3
)
RETURNS TABLE (
    author_id INTEGER,
    full_name TEXT,
    paper_count BIGINT,
    first_year INTEGER,
    last_year INTEGER,
    institutions TEXT[]
)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE topic_tree(id) AS (
        SELECT Topic_ID FROM TOPIC WHERE Topic_ID = p_topic_id
      UNION
        SELECT t.Topic_ID FROM TOPIC t JOIN topic_tree tt ON t.Parent_Topic_ID = tt.id
    ),
    topic_papers AS (
        SELECT DISTINCT p.Paper_ID, p.Publication_Year
        FROM PAPER_TOPIC pt
        JOIN PAPER p ON p.Paper_ID = pt.Paper_ID
        WHERE pt.Topic_ID IN (SELECT id FROM topic_tree)
          AND pt.Relevance_Score >= p_min_relevance
          AND p.Publication_Year BETWEEN p_year_from AND p_year_to
    )
    SELECT a.Author_ID,
           a.Full_Name::TEXT,
           COUNT(DISTINCT tp.Paper_ID),
           MIN(tp.Publication_Year),
           MAX(tp.Publication_Year),
           COALESCE(
               ARRAY_AGG(DISTINCT i.Institution_Name::TEXT) FILTER (WHERE i.Institution_Name IS NOT NULL),
               ARRAY[]::TEXT[]
           )
    FROM topic_papers tp
    JOIN AUTHORSHIP s ON s.Paper_ID = tp.Paper_ID
    JOIN AUTHOR a ON a.Author_ID = s.Author_ID
    LEFT JOIN PAPER_AUTHOR_INSTITUTION pai ON pai.Paper_ID = tp.Paper_ID AND pai.Author_ID = a.Author_ID
    LEFT JOIN INSTITUTION i ON i.Institution_ID = pai.Institution_ID
    GROUP BY a.Author_ID, a.Full_Name
$$;
