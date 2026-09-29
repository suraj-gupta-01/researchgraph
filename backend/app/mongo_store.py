"""
MongoDB access for the flexible, variable-shape data (PRD Section 6.4):
abstracts, keywords, embeddings, raw API responses.

Why Mongo is in the read path and not just a dump: F1 needs to find papers
whose *abstract* or keywords match a topic, and abstracts are exactly the
unstructured text that does not belong in the relational schema. Postgres
answers "which papers have this title / topic tag"; Mongo answers "which
papers talk about this". The search layer unions the two.

All functions raise on Mongo errors; callers decide whether to degrade.
"""
from __future__ import annotations

import re

from pymongo import ASCENDING

from app.db import get_mongo_db

COLLECTION = "paper_metadata"

# Mongo's English text index drops these; quoting one as a required phrase
# would make the AND-query match nothing, so drop them from the query too.
_STOPWORDS = frozenset(
    "a an and are as at be by for from has have in is it its of on or that the this to was were with".split()
)
_TOKEN = re.compile(r"\w+(?:[-']\w+)*", re.UNICODE)


def _col():
    return get_mongo_db()[COLLECTION]


def query_tokens(q: str, max_tokens: int = 8) -> list[str]:
    tokens = [t for t in _TOKEN.findall(q.lower()) if t not in _STOPWORDS]
    return tokens[:max_tokens]


def build_text_query(q: str) -> str | None:
    """'federated learning privacy' -> '"federated" "learning" "privacy"'.
    In $text, each quoted phrase is required, so this gives AND semantics
    (every term must appear) rather than Mongo's default OR."""
    tokens = query_tokens(q)
    if not tokens:
        return None
    return " ".join(f'"{t}"' for t in tokens)


def ensure_indexes() -> None:
    col = _col()
    col.create_index([("paper_id", ASCENDING), ("source", ASCENDING)], name="paper_source")
    col.create_index(
        [("abstract", "text"), ("keywords", "text")],
        name="text_abstract_keywords",
        default_language="english",
    )


def text_search(q: str, limit: int = 2000) -> dict[int, float]:
    """paper_id -> best Mongo text score, over abstract + keywords."""
    search = build_text_query(q)
    if not search:
        return {}
    cursor = (
        _col()
        .find({"$text": {"$search": search}}, {"_id": 0, "paper_id": 1, "score": {"$meta": "textScore"}})
        .sort([("score", {"$meta": "textScore"})])
        .limit(limit)
    )
    best: dict[int, float] = {}
    for doc in cursor:
        pid = doc.get("paper_id")
        if pid is None:
            continue
        best[pid] = max(best.get(pid, 0.0), float(doc.get("score", 0.0)))
    return best


def keyword_counts(paper_ids: list[int], exclude: set[str] | None = None, limit: int = 12) -> list[dict]:
    """Most common keywords across a set of papers (distinct papers per keyword)."""
    if not paper_ids:
        return []
    exclude = {e.lower() for e in (exclude or set())}
    pipeline = [
        {"$match": {"paper_id": {"$in": paper_ids}}},
        {"$unwind": "$keywords"},
        {"$group": {"_id": {"$toLower": "$keywords"}, "papers": {"$addToSet": "$paper_id"}}},
        {"$project": {"count": {"$size": "$papers"}}},
        {"$sort": {"count": -1, "_id": 1}},
        {"$limit": limit + len(exclude) + 5},
    ]
    out = []
    for doc in _col().aggregate(pipeline):
        kw = doc["_id"]
        if not kw or kw in exclude:
            continue
        out.append({"keyword": kw, "paper_count": doc["count"]})
        if len(out) >= limit:
            break
    return out


def paper_text(paper_id: int) -> dict | None:
    """Abstract + keywords for one paper. Prefers a document that actually has
    an abstract (either source), else falls back to any document for keywords."""
    col = _col()
    doc = col.find_one(
        {"paper_id": paper_id, "abstract": {"$nin": [None, ""]}},
        {"_id": 0, "abstract": 1, "keywords": 1, "source": 1},
    )
    if doc is None:
        doc = col.find_one({"paper_id": paper_id}, {"_id": 0, "abstract": 1, "keywords": 1, "source": 1})
    return doc


def community_snapshot() -> dict | None:
    """The last community-detection run written by graph.communities: its
    parameters plus per-community label evidence (graph-analysis result blob,
    PRD 6.4). Postgres stays the source of truth for the communities
    themselves; callers must check `detected_at` against
    RESEARCH_COMMUNITY.Detection_Date before trusting the evidence."""
    return get_mongo_db()["graph_snapshot"].find_one({"_id": "communities"})


def trend_snapshot() -> dict | None:
    """The last emerging-topic run written by graph.trends: its parameters
    and label counts (graph-analysis result blob, PRD 6.4). Postgres
    (TOPIC_SNAPSHOT / RESEARCH_TREND) is authoritative for the trends
    themselves; this is run metadata for auditability, not a data source."""
    return get_mongo_db()["graph_snapshot"].find_one({"_id": "trends"})


def run_snapshots(ids: list[str]) -> list[dict]:
    """Run summaries from graph_snapshot (G4, /meta/runs). Raises when Mongo
    is unreachable; the caller reports that as mongo: unavailable."""
    return list(get_mongo_db()["graph_snapshot"].find({"_id": {"$in": ids}}))
