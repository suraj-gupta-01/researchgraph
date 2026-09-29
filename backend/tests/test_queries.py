"""
G6 -- the PRD Section 9 demo queries (/queries/*), against a real PostgreSQL
with 06_query_lab.sql applied. Each endpoint's answer is re-derived here
from the base tables with an independent query, so a view that drifts from
the PRD sentence it claims to answer fails the test.
"""
from __future__ import annotations

import pytest

from tests.conftest import q


@pytest.fixture(scope="module")
def communities_run(seeded, mongo):
    from graph.communities import detect_and_store
    from ingestion.extract_topics import extract_topics

    extract_topics()
    return detect_and_store()


def _get(client, path, **params):
    r = client.get(path, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _all(client, path, **params):
    items, offset = [], 0
    while True:
        body = _get(client, path, limit=100, offset=offset, **params)
        items += body["items"]
        offset += 100
        if offset >= body["total"]:
            return items, body["total"]


# ============================================================
# Catalog
# ============================================================

def test_catalog_lists_every_section9_query_with_live_definitions(client, communities_run):
    body = _get(client, "/queries/catalog")
    keys = [e["key"] for e in body]
    assert keys == ["topic-authors", "cross-community-citations", "institution-topic-collaboration", "topic-year-counts", "citation-chain"]
    for e in body:
        assert e["statement"].strip().upper().startswith(("SELECT", "WITH"))
        for o in e["objects"]:
            assert o["definition"], f"{o['name']} definition should be fetched from Postgres"
    chain = next(e for e in body if e["key"] == "citation-chain")
    assert "RECURSIVE" in chain["statement"]


# ============================================================
# Cross-community citations
# ============================================================

def _paper_community(engine) -> dict[int, int]:
    """Majority community of each paper's authors, ties -> lowest id."""
    rows = q(
        engine,
        "SELECT s.Paper_ID, cm.Community_ID, COUNT(*) FROM AUTHORSHIP s "
        "JOIN COMMUNITY_MEMBER cm ON cm.Author_ID = s.Author_ID GROUP BY s.Paper_ID, cm.Community_ID",
    )
    best: dict[int, tuple[int, int]] = {}
    for pid, cid, n in rows:
        cur = best.get(pid)
        if cur is None or n > cur[1] or (n == cur[1] and cid < cur[0]):
            best[pid] = (cid, n)
    return {pid: cid for pid, (cid, _) in best.items()}


def test_cross_community_citations_match_the_base_tables(client, engine, communities_run):
    community = _paper_community(engine)
    expected = {
        (a, b)
        for a, b in q(engine, "SELECT Citing_Paper_ID, Cited_Paper_ID FROM CITATION")
        if a in community and b in community and community[a] != community[b]
    }
    items, total = _all(client, "/queries/cross-community-citations")
    assert expected, "the seeded corpus has citations across communities"
    assert total == len(expected)
    assert {(i["citing_paper_id"], i["cited_paper_id"]) for i in items} == expected
    for i in items:
        assert i["citing_community_id"] != i["cited_community_id"]
        assert i["citing_community_id"] == community[i["citing_paper_id"]]


def test_cross_community_filter_by_community(client, communities_run):
    items, _ = _all(client, "/queries/cross-community-citations")
    cid = items[0]["citing_community_id"]
    scoped, total = _all(client, "/queries/cross-community-citations", community_id=cid)
    assert total == len(scoped) > 0
    assert all(cid in (i["citing_community_id"], i["cited_community_id"]) for i in scoped)


# ============================================================
# Institutions collaborating across two topics
# ============================================================

def _co_topic_pair(engine) -> tuple[int, int]:
    rows = q(
        engine,
        "SELECT a.Topic_ID, b.Topic_ID, COUNT(*) FROM PAPER_TOPIC a JOIN PAPER_TOPIC b "
        "ON a.Paper_ID = b.Paper_ID AND a.Topic_ID < b.Topic_ID "
        "WHERE a.Relevance_Score >= 0.3 AND b.Relevance_Score >= 0.3 "
        "AND a.Paper_ID IN (SELECT Paper_ID FROM COLLABORATION) "
        "GROUP BY a.Topic_ID, b.Topic_ID ORDER BY COUNT(*) DESC LIMIT 1",
    )
    if not rows:
        pytest.skip("no two topics co-occur on a collaborative paper in this seeded run")
    return rows[0][0], rows[0][1]


def test_institution_pairs_share_papers_tagged_with_both_topics(client, engine, communities_run):
    ta, tb = _co_topic_pair(engine)
    items, total = _all(client, "/queries/institution-topic-collaboration", topic_a=ta, topic_b=tb)
    both = {
        pid for (pid,) in q(
            engine,
            "SELECT Paper_ID FROM PAPER_TOPIC WHERE Topic_ID IN (:a, :b) AND Relevance_Score >= 0.3 "
            "GROUP BY Paper_ID HAVING COUNT(DISTINCT Topic_ID) = 2",
            a=ta, b=tb,
        )
    }
    expected: dict[tuple[int, int], int] = {}
    for ia, ib, pid in q(engine, "SELECT Institution_A_ID, Institution_B_ID, Paper_ID FROM COLLABORATION"):
        if pid in both:
            expected[(ia, ib)] = expected.get((ia, ib), 0) + 1
    assert total == len(expected) == len(items)
    assert {(i["institution_a_id"], i["institution_b_id"]): i["shared_papers"] for i in items} == expected
    counts = [i["shared_papers"] for i in items]
    assert counts == sorted(counts, reverse=True)
    for i in items:
        assert 1 <= len(i["example_paper_ids"]) <= 5
        assert set(i["example_paper_ids"]) <= both


def test_topic_order_does_not_matter(client, engine, communities_run):
    ta, tb = _co_topic_pair(engine)
    one = _get(client, "/queries/institution-topic-collaboration", topic_a=ta, topic_b=tb)
    two = _get(client, "/queries/institution-topic-collaboration", topic_a=tb, topic_b=ta)
    assert one["items"] == two["items"]


def test_same_topic_twice_is_422_and_unknown_topic_is_404(client):
    assert client.get("/queries/institution-topic-collaboration", params={"topic_a": 1, "topic_b": 1}).status_code == 422
    assert client.get("/queries/institution-topic-collaboration", params={"topic_a": 1, "topic_b": 2_000_000_000}).status_code == 404


def test_page_past_the_end_still_reports_the_total(client, engine, communities_run):
    ta, tb = _co_topic_pair(engine)
    first = _get(client, "/queries/institution-topic-collaboration", topic_a=ta, topic_b=tb)
    past = _get(client, "/queries/institution-topic-collaboration", topic_a=ta, topic_b=tb, offset=10_000)
    assert past["items"] == [] and past["total"] == first["total"]


# ============================================================
# Authors on a topic in a year range
# ============================================================

def test_topic_authors_match_the_base_tables(client, engine, communities_run):
    tid = q(engine, "SELECT Topic_ID FROM PAPER_TOPIC WHERE Relevance_Score >= 0.3 GROUP BY Topic_ID ORDER BY COUNT(*) DESC LIMIT 1")[0][0]
    items, total = _all(client, "/queries/topic-authors", topic_id=tid, year_from=2023, year_to=2025)
    rows = q(
        engine,
        "SELECT s.Author_ID, COUNT(DISTINCT p.Paper_ID) FROM PAPER_TOPIC pt "
        "JOIN PAPER p ON p.Paper_ID = pt.Paper_ID JOIN AUTHORSHIP s ON s.Paper_ID = p.Paper_ID "
        "WHERE pt.Topic_ID = :t AND pt.Relevance_Score >= 0.3 AND p.Publication_Year BETWEEN 2023 AND 2025 "
        "GROUP BY s.Author_ID",
        t=tid,
    )
    assert total == len(rows) == len(items) > 0
    assert {i["author_id"]: i["paper_count"] for i in items} == dict(rows)
    for i in items:
        assert 2023 <= i["first_year"] <= i["last_year"] <= 2025
    counts = [i["paper_count"] for i in items]
    assert counts == sorted(counts, reverse=True)


def test_topic_authors_institutions_come_from_per_paper_attribution(client, engine, communities_run):
    tid = q(engine, "SELECT Topic_ID FROM PAPER_TOPIC GROUP BY Topic_ID ORDER BY COUNT(*) DESC LIMIT 1")[0][0]
    items, _ = _all(client, "/queries/topic-authors", topic_id=tid, year_from=1900, year_to=2100, min_relevance=0)
    a = next(i for i in items if i["institutions"])
    names = {
        n for (n,) in q(
            engine,
            "SELECT DISTINCT i.Institution_Name FROM PAPER_AUTHOR_INSTITUTION pai "
            "JOIN INSTITUTION i ON i.Institution_ID = pai.Institution_ID "
            "JOIN PAPER_TOPIC pt ON pt.Paper_ID = pai.Paper_ID WHERE pai.Author_ID = :a AND pt.Topic_ID = :t",
            a=a["author_id"], t=tid,
        )
    }
    assert set(a["institutions"]) == names


@pytest.mark.parametrize(
    "params, status",
    [
        ({"topic_id": 1, "year_from": 2025, "year_to": 2020}, 422),
        ({"topic_id": 1, "year_from": 2020}, 422),
        ({"topic_id": 2_000_000_000, "year_from": 2020, "year_to": 2025}, 404),
    ],
)
def test_topic_authors_validation(client, params, status):
    assert client.get("/queries/topic-authors", params=params).status_code == status


# ============================================================
# Per-topic year aggregation
# ============================================================

def test_topic_year_counts_group_papers_by_year(client, engine, communities_run):
    tid = q(engine, "SELECT Topic_ID FROM PAPER_TOPIC GROUP BY Topic_ID ORDER BY COUNT(*) DESC LIMIT 1")[0][0]
    body = _get(client, "/queries/topic-year-counts", topic_id=tid)
    expected = dict(q(
        engine,
        "SELECT p.Publication_Year, COUNT(*) FROM PAPER_TOPIC pt JOIN PAPER p ON p.Paper_ID = pt.Paper_ID "
        "WHERE pt.Topic_ID = :t GROUP BY p.Publication_Year",
        t=tid,
    ))
    assert {r["year"]: r["paper_count"] for r in body} == expected
    assert [r["year"] for r in body] == sorted(expected)


def test_topic_year_counts_unknown_topic_is_404(client):
    assert client.get("/queries/topic-year-counts", params={"topic_id": 2_000_000_000}).status_code == 404
