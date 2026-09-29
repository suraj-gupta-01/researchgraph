from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.conftest import q


def ids(page):
    return [i["paper_id"] for i in page["items"]]


# ---- papers ---------------------------------------------------------------

def test_papers_pagination_is_stable_and_complete(client, engine):
    total = q(engine, "SELECT COUNT(*) FROM PAPER")[0][0]
    seen, offset = [], 0
    while True:
        r = client.get("/papers", params={"limit": 50, "offset": offset}).json()
        assert r["total"] == total
        seen += ids(r)
        offset += 50
        if offset >= total:
            break
    assert len(seen) == len(set(seen)) == total


def test_papers_sorted_by_citations_and_year_filter(client):
    r = client.get("/papers", params={"limit": 100, "sort": "citations"}).json()
    cites = [i["citation_count"] for i in r["items"]]
    assert cites == sorted(cites, reverse=True)
    r = client.get("/papers", params={"year_from": 2022, "year_to": 2023, "limit": 100}).json()
    assert r["total"] > 0 and all(2022 <= i["publication_year"] <= 2023 for i in r["items"])


def test_papers_title_search_and_relevance_sort(client):
    r = client.get("/papers", params={"q": "differential privacy", "sort": "relevance"}).json()
    assert r["total"] == 0 or all("privat" in i["title"].lower() for i in r["items"])
    r = client.get("/papers", params={"q": "Federated Medical Imaging"}).json()
    assert r["total"] > 0 and all("medical imaging" in i["title"].lower() for i in r["items"])
    assert client.get("/papers", params={"sort": "relevance"}).status_code == 422


def test_paper_detail_has_authors_affiliations_provenance_and_abstract(client, engine):
    both = q(engine, "SELECT Paper_ID FROM PAPER_SOURCE GROUP BY Paper_ID HAVING COUNT(*) = 2 LIMIT 1")[0][0]
    d = client.get(f"/papers/{both}").json()
    assert {s["source_name"] for s in d["sources"]} == {"openalex", "semantic_scholar"}
    assert d["authors"] and all(a["institutions"] for a in d["authors"])
    assert d["abstract"] and d["text_status"] == "ok" and d["keywords"]
    out = q(engine, "SELECT COUNT(*) FROM CITATION WHERE Citing_Paper_ID = :i", i=both)[0][0]
    inn = q(engine, "SELECT COUNT(*) FROM CITATION WHERE Cited_Paper_ID = :i", i=both)[0][0]
    assert (d["cites_in_corpus"], d["cited_by_in_corpus"]) == (out, inn)
    assert client.get("/papers/99999999").status_code == 404


def test_citations_directions_are_mirror_images(client, engine):
    a, b = q(engine, "SELECT Citing_Paper_ID, Cited_Paper_ID FROM CITATION LIMIT 1")[0]
    cites = client.get(f"/papers/{a}/citations", params={"direction": "cites", "limit": 100}).json()
    cited_by = client.get(f"/papers/{b}/citations", params={"direction": "cited_by", "limit": 100}).json()
    assert b in ids(cites) and a in ids(cited_by)


def test_citation_chain_depths_and_cycle_safety(client, engine):
    start = q(
        engine,
        "SELECT Citing_Paper_ID FROM CITATION GROUP BY Citing_Paper_ID ORDER BY COUNT(*) DESC LIMIT 1",
    )[0][0]
    d1 = client.get(f"/papers/{start}/citation-chain", params={"depth": 1}).json()
    d3 = client.get(f"/papers/{start}/citation-chain", params={"depth": 3}).json()
    direct = q(engine, "SELECT COUNT(*) FROM CITATION WHERE Citing_Paper_ID = :i", i=start)[0][0]
    assert len(d1) == direct and all(n["depth"] == 1 for n in d1)
    assert {n["paper_id"] for n in d1} <= {n["paper_id"] for n in d3}
    assert start not in {n["paper_id"] for n in d3}
    assert len({n["paper_id"] for n in d3}) == len(d3)

    # inject a cycle a->b->a and confirm the recursion terminates
    a, b = q(engine, "SELECT Citing_Paper_ID, Cited_Paper_ID FROM CITATION LIMIT 1")[0]
    with engine.begin() as c:
        added = c.execute(text(
            "INSERT INTO CITATION (Citing_Paper_ID, Cited_Paper_ID) VALUES (:b, :a) ON CONFLICT DO NOTHING"),
            {"a": a, "b": b}).rowcount
    try:
        r = client.get(f"/papers/{a}/citation-chain", params={"depth": 5})
        assert r.status_code == 200 and a not in {n["paper_id"] for n in r.json()}
    finally:
        if added:
            with engine.begin() as c:
                c.execute(text("DELETE FROM CITATION WHERE Citing_Paper_ID = :b AND Cited_Paper_ID = :a"), {"a": a, "b": b})


# ---- authors / institutions / venues -------------------------------------

def test_author_stats_match_authorship(client, engine):
    r = client.get("/authors", params={"limit": 5}).json()
    for a in r["items"]:
        n = q(engine, "SELECT COUNT(*) FROM AUTHORSHIP WHERE Author_ID = :i", i=a["author_id"])[0][0]
        assert a["paper_count"] == n
    aid = r["items"][0]["author_id"]
    d = client.get(f"/authors/{aid}").json()
    assert d["institutions"] and aid not in {c["author_id"] for c in d["coauthors"]}
    assert sum(y["paper_count"] for y in d["papers_by_year"]) == d["paper_count"]
    papers = client.get("/papers", params={"author_id": aid, "limit": 100}).json()
    assert papers["total"] == d["paper_count"]


def test_institution_collaborators_are_symmetric(client, engine):
    a, b = q(engine, "SELECT Institution_A_ID, Institution_B_ID FROM COLLABORATION LIMIT 1")[0]
    ab = {c["institution_id"]: c["shared_papers"] for c in client.get(f"/institutions/{a}/collaborators", params={"limit": 100}).json()["items"]}
    ba = {c["institution_id"]: c["shared_papers"] for c in client.get(f"/institutions/{b}/collaborators", params={"limit": 100}).json()["items"]}
    assert ab[b] == ba[a]
    d = client.get(f"/institutions/{a}").json()
    assert d["paper_count"] > 0 and d["top_authors"]


def test_venues_list_and_detail(client):
    r = client.get("/venues").json()
    assert r["total"] >= 1
    d = client.get(f"/venues/{r['items'][0]['venue_id']}").json()
    assert sum(y["paper_count"] for y in d["papers_by_year"]) == d["paper_count"]


# ---- topics (hierarchy) ---------------------------------------------------

@pytest.fixture()
def topics(engine):
    with engine.begin() as c:
        parent = c.execute(text("INSERT INTO TOPIC (Topic_Name) VALUES ('Zzz Parent Topic') RETURNING Topic_ID")).scalar_one()
        child = c.execute(text("INSERT INTO TOPIC (Topic_Name, Parent_Topic_ID) VALUES ('Zzz Child Topic', :p) RETURNING Topic_ID"), {"p": parent}).scalar_one()
        pid = c.execute(text("SELECT Paper_ID FROM PAPER ORDER BY Paper_ID LIMIT 1")).scalar_one()
        c.execute(text("INSERT INTO PAPER_TOPIC (Paper_ID, Topic_ID, Relevance_Score, Extraction_Method) VALUES (:p, :t, 0.9, 'test')"), {"p": pid, "t": child})
    yield parent, child, pid
    with engine.begin() as c:
        c.execute(text("DELETE FROM TOPIC WHERE Topic_ID IN (:a, :b)"), {"a": parent, "b": child})


def test_topic_descendants_included_in_filters_and_search(client, topics):
    parent, child, pid = topics
    assert pid in ids(client.get("/papers", params={"topic_id": parent}).json())
    r = client.get("/search/papers", params={"q": "zzz parent topic"}).json()
    assert ids(r) == [pid]
    d = client.get(f"/topics/{parent}").json()
    assert [c["topic_id"] for c in d["children"]] == [child]
    assert client.get("/search/overview", params={"q": "zzz parent topic"}).json()["topics"][0]["topic_id"] == child


# ---- F1 search -------------------------------------------------------------

def test_search_overview_agrees_with_search_papers(client):
    o = client.get("/search/overview", params={"q": "federated learning"}).json()
    p = client.get("/search/papers", params={"q": "federated learning", "limit": 100}).json()
    assert o["summary"]["papers"] == p["total"] > 0
    assert sum(y["paper_count"] for y in o["year_histogram"]) == p["total"]
    assert o["top_authors"] and o["top_institutions"] and o["top_venues"] and o["keywords"]
    assert o["meta"]["mongo"] == "ok" and o["meta"]["matched_via"]["abstract"] > 0


def test_search_relevance_prefers_title_hits_and_year_filter_keeps_histogram(client):
    r = client.get("/search/papers", params={"q": "federated learning", "limit": 100}).json()
    rel = [i["relevance"] for i in r["items"]]
    assert rel == sorted(rel, reverse=True) and rel[0] == 4.0      # title (3) + abstract (1)
    only_abstract = client.get("/search/papers", params={"q": "privacy", "limit": 100}).json()
    assert {i["relevance"] for i in only_abstract["items"]} == {1.0}   # 'privacy' never appears in a title
    full = client.get("/search/overview", params={"q": "privacy"}).json()
    narrowed = client.get("/search/overview", params={"q": "privacy", "year_from": 2024}).json()
    assert narrowed["summary"]["papers"] < full["summary"]["papers"]
    assert narrowed["year_histogram"] == full["year_histogram"]      # histogram ignores the year filter


def test_search_facet_filters_narrow_results(client):
    o = client.get("/search/overview", params={"q": "federated learning"}).json()
    aid = o["top_authors"][0]["author_id"]
    n = client.get("/search/papers", params={"q": "federated learning", "author_id": aid}).json()
    assert 0 < n["total"] == o["top_authors"][0]["paper_count"]


def test_search_degrades_when_mongo_is_down(client, monkeypatch):
    from app import mongo_store

    def boom(*a, **k):
        raise RuntimeError("mongo down")

    monkeypatch.setattr(mongo_store, "text_search", boom)
    monkeypatch.setattr(mongo_store, "keyword_counts", boom)
    o = client.get("/search/overview", params={"q": "federated medical imaging"}).json()
    assert o["meta"]["mongo"] == "unavailable" and o["summary"]["papers"] > 0 and o["keywords"] == []


def test_search_with_only_stopwords_and_no_matches(client):
    o = client.get("/search/overview", params={"q": "the of"}).json()
    assert o["meta"]["mongo"] == "skipped"
    o = client.get("/search/overview", params={"q": "quantum gravity cheese"}).json()
    assert o["summary"]["papers"] == 0 and o["year_histogram"] == []


# ---- validation & injection ---------------------------------------------

@pytest.mark.parametrize("url", [
    "/papers?limit=1000", "/papers?limit=0", "/papers?offset=-1", "/papers?sort=bogus",
    "/papers?year_from=abc", "/search/overview?q=", "/search/papers", "/papers/abc",
    "/papers/1/citation-chain?depth=99", "/authors?sort=name;DROP",
])
def test_bad_input_is_rejected(client, url):
    assert client.get(url).status_code == 422


def test_sql_injection_and_like_wildcards_are_inert(client, engine):
    evil = "'; DROP TABLE paper; --"
    for path in ("/papers", "/authors", "/institutions", "/venues", "/topics"):
        assert client.get(path, params={"q": evil}).status_code == 200
    assert client.get("/search/overview", params={"q": evil}).status_code == 200
    assert q(engine, "SELECT COUNT(*) FROM PAPER")[0][0] > 0
    assert client.get("/authors", params={"q": "%"}).json()["total"] == 0     # % is literal, not a wildcard
    assert client.get("/authors", params={"q": "_"}).json()["total"] == 0
