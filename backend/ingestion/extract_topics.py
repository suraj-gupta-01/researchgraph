"""
M3 — NLP topic extraction (PRD F3/G3).

Populates TOPIC and PAPER_TOPIC from two lanes that are kept clearly
separate via Extraction_Method, because they have very different
trustworthiness and evaluators will ask "where did this topic come from":

  * 'source_keyword' — curated vocabulary the source already assigned
    (OpenAlex `keywords`, Semantic Scholar `fieldsOfStudy`), stored on the
    Mongo paper_metadata document by the loader. Treated as ground truth:
    Relevance_Score = 1.0000.
  * 'tfidf'           — corpus-wide TF-IDF over "title + abstract", unigrams
    to trigrams, mined independently per paper. This is what actually does
    NLP work: common phrases every paper in the demo corpus shares (e.g.
    "federated learning") wash out because they carry no discriminative
    weight across the corpus, while phrases that mark out a sub-topic (e.g.
    "differential privacy", "medical imaging") float to the top. Relevance
    per paper is that paper's TF-IDF weight, min-max normalized against its
    own top term so scores are comparable across papers of different length.

Both lanes write into the same TOPIC vocabulary (case-insensitive on
Topic_Name), so a term that shows up both as a curated keyword and as a
mined phrase collapses onto one row instead of two.

Idempotent and safe to re-run as the corpus grows (e.g. after every
ingestion batch): TOPIC lookups are upserts, PAPER_TOPIC rows are upserted
per (Paper_ID, Topic_ID, Extraction_Method) so a later run's scores replace
the prior ones rather than duplicating or being skipped.

Deliberately NOT attempted here (left for the team, noted in README):
  * Topic hierarchy (Parent_Topic_ID) — nothing in title/abstract text or
    source keywords cleanly implies a parent/child relationship; guessing
    one from string containment (e.g. "learning" as parent of "federated
    learning") would produce nonsense parents as often as real ones. Every
    TOPIC row this job creates has Parent_Topic_ID = NULL; building the
    hierarchy is a separate, judgment-heavy task better done deliberately.
  * Embeddings-based extraction (SPECTER etc.) — Semantic Scholar can ship
    an embedding (see NormalizedPaper.embedding / PRD 6.2) but nothing in
    the M1/M2 loader path persists it yet, so there is nothing to cluster
    on. TF-IDF is the extraction method that matches the data actually on
    hand today.
"""
from __future__ import annotations

import logging
import re

from sklearn.feature_extraction.text import TfidfVectorizer
from sqlalchemy import text

from app.db import get_engine, get_mongo_db

log = logging.getLogger("researchgraph.extract_topics")

TFIDF_METHOD = "tfidf"
SOURCE_METHOD = "source_keyword"

TOP_TERMS_PER_PAPER = 6
MIN_RELEVANCE = 0.15  # drop the long tail of near-zero TF-IDF weights per paper
MAX_VOCAB = 4000

_WORD = re.compile(r"[a-zA-Z][a-zA-Z\-]+")


def _fetch_papers(conn) -> list[dict]:
    rows = conn.execute(text("SELECT Paper_ID, Title FROM PAPER")).mappings().all()
    return [dict(r) for r in rows]


def _fetch_mongo_text(paper_ids: list[int]) -> dict[int, dict]:
    """paper_id -> {"abstract": str|None, "keywords": list[str]}, preferring
    whichever source document actually has an abstract (mirrors
    app.mongo_store.paper_text, but batched for the whole corpus)."""
    col = get_mongo_db()["paper_metadata"]
    by_paper: dict[int, dict] = {}
    for doc in col.find({"paper_id": {"$in": paper_ids}}, {"_id": 0, "paper_id": 1, "abstract": 1, "keywords": 1}):
        pid = doc.get("paper_id")
        if pid is None:
            continue
        has_abstract = bool(doc.get("abstract"))
        existing = by_paper.get(pid)
        if existing is None or (has_abstract and not existing.get("abstract")):
            by_paper[pid] = {"abstract": doc.get("abstract"), "keywords": list(doc.get("keywords") or [])}
        elif existing is not None:
            # merge keywords across source documents for the same paper
            existing_kw = set(k.lower() for k in existing.get("keywords") or [])
            for kw in doc.get("keywords") or []:
                if kw.lower() not in existing_kw:
                    existing.setdefault("keywords", []).append(kw)
                    existing_kw.add(kw.lower())
    return by_paper


def _normalize_topic_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().lower()


def _get_or_create_topic_ids(conn, names: set[str]) -> dict[str, int]:
    """Case-insensitive upsert of TOPIC.Topic_Name -> Topic_ID for every name
    in `names`. Existing rows (from a prior run, or seeded manually) are
    reused rather than duplicated."""
    if not names:
        return {}
    existing = conn.execute(
        text("SELECT Topic_ID, LOWER(Topic_Name) AS norm FROM TOPIC WHERE LOWER(Topic_Name) = ANY(:names)"),
        {"names": list(names)},
    ).mappings().all()
    ids = {row["norm"]: row["topic_id"] for row in existing}
    missing = names - ids.keys()
    for name in missing:
        row = conn.execute(
            text(
                "INSERT INTO TOPIC (Topic_Name) VALUES (:name) "
                "ON CONFLICT (Topic_Name) DO UPDATE SET Topic_Name = EXCLUDED.Topic_Name "
                "RETURNING Topic_ID"
            ),
            {"name": name},
        ).mappings().one()
        ids[name] = row["topic_id"]
    return ids


_UPSERT_PAPER_TOPIC = """
INSERT INTO PAPER_TOPIC (Paper_ID, Topic_ID, Relevance_Score, Extraction_Method)
VALUES (:paper_id, :topic_id, :score, :method)
ON CONFLICT (Paper_ID, Topic_ID) DO UPDATE
  SET Relevance_Score = GREATEST(EXCLUDED.Relevance_Score, PAPER_TOPIC.Relevance_Score),
      Extraction_Method = CASE
          WHEN EXCLUDED.Relevance_Score >= PAPER_TOPIC.Relevance_Score THEN EXCLUDED.Extraction_Method
          ELSE PAPER_TOPIC.Extraction_Method
      END
"""


def _upsert_source_keywords(conn, paper_id: int, keywords: list[str]) -> int:
    names = {_normalize_topic_name(k) for k in keywords if k and len(k.strip()) >= 3}
    if not names:
        return 0
    topic_ids = _get_or_create_topic_ids(conn, names)
    n = 0
    for name in names:
        conn.execute(
            text(_UPSERT_PAPER_TOPIC),
            {"paper_id": paper_id, "topic_id": topic_ids[name], "score": 1.0, "method": SOURCE_METHOD},
        )
        n += 1
    return n


def _tfidf_terms_per_paper(paper_ids: list[int], corpus: list[str]) -> dict[int, list[tuple[str, float]]]:
    """paper_id -> [(term, relevance in [0,1]), ...], top TOP_TERMS_PER_PAPER
    terms by TF-IDF weight, min-max normalized per paper."""
    non_empty = [(pid, doc) for pid, doc in zip(paper_ids, corpus) if doc.strip()]
    if len(non_empty) < 2:
        # TF-IDF needs a corpus to compute IDF against; nothing meaningful to
        # extract from 0-1 documents.
        return {}
    ids, docs = zip(*non_empty)

    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        stop_words="english",
        max_features=MAX_VOCAB,
        min_df=2,  # a phrase has to recur across papers to count as a "topic", not paper-unique noise
        token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z\-]{2,}\b",
    )
    try:
        matrix = vectorizer.fit_transform(docs)
    except ValueError:
        # e.g. every remaining term was filtered by min_df on a tiny corpus
        vectorizer = TfidfVectorizer(ngram_range=(1, 2), stop_words="english", max_features=MAX_VOCAB, min_df=1)
        matrix = vectorizer.fit_transform(docs)

    vocab = vectorizer.get_feature_names_out()
    result: dict[int, list[tuple[str, float]]] = {}
    csr = matrix.tocsr()
    for row_idx, pid in enumerate(ids):
        row = csr.getrow(row_idx)
        if row.nnz == 0:
            continue
        pairs = sorted(zip(row.indices, row.data), key=lambda t: t[1], reverse=True)[:TOP_TERMS_PER_PAPER]
        top_weight = pairs[0][1]
        terms = []
        for col_idx, weight in pairs:
            # weight/top_weight are numpy.float64 (straight off the sparse
            # matrix); psycopg2 has no adapter for that type and raises
            # InvalidSchemaName on the first bind, so cast down to a plain
            # Python float before it ever reaches a query parameter.
            score = round(float(weight) / float(top_weight), 4) if top_weight else 0.0
            if score >= MIN_RELEVANCE:
                terms.append((vocab[col_idx], score))
        if terms:
            result[pid] = terms
    return result


def extract_topics() -> dict[str, int]:
    """Run both lanes over every paper currently in Postgres. Returns counts
    for the run summary / logs."""
    engine = get_engine()
    with engine.connect() as conn:
        papers = _fetch_papers(conn)
    if not papers:
        log.info("No papers in PAPER table yet; nothing to extract topics from.")
        return {"papers_considered": 0, "source_keyword_rows": 0, "tfidf_rows": 0}

    paper_ids = [p["paper_id"] for p in papers]
    mongo_text = _fetch_mongo_text(paper_ids)

    corpus = []
    for p in papers:
        m = mongo_text.get(p["paper_id"], {})
        corpus.append(f"{p['title']} {m.get('abstract') or ''}")

    source_kw_rows = 0
    with engine.begin() as conn:
        for p in papers:
            kws = mongo_text.get(p["paper_id"], {}).get("keywords") or []
            source_kw_rows += _upsert_source_keywords(conn, p["paper_id"], kws)

    per_paper_terms = _tfidf_terms_per_paper(paper_ids, corpus)
    tfidf_rows = 0
    with engine.begin() as conn:
        # Re-runs must REPLACE the previous mined topics, not accumulate them:
        # a phrase that fell below threshold (or a paper whose abstract changed)
        # would otherwise keep a stale row forever. Only 'tfidf' rows are
        # touched; source_keyword rows (and tfidf rows a keyword later took
        # over, whose method is now source_keyword) are left alone. Skipped
        # when the corpus is too small to compute IDF, so a 1-paper run never
        # wipes a good earlier result.
        if per_paper_terms:
            conn.execute(
                text("DELETE FROM PAPER_TOPIC WHERE Extraction_Method = :m AND Paper_ID = ANY(:ids)"),
                {"m": TFIDF_METHOD, "ids": paper_ids},
            )
        for pid, terms in per_paper_terms.items():
            names = {_normalize_topic_name(term) for term, _ in terms}
            topic_ids = _get_or_create_topic_ids(conn, names)
            for term, score in terms:
                name = _normalize_topic_name(term)
                conn.execute(
                    text(_UPSERT_PAPER_TOPIC),
                    {"paper_id": pid, "topic_id": topic_ids[name], "score": score, "method": TFIDF_METHOD},
                )
                tfidf_rows += 1

    stats = {"papers_considered": len(papers), "source_keyword_rows": source_kw_rows, "tfidf_rows": tfidf_rows}
    log.info("Topic extraction: %s", stats)
    return stats


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    extract_topics()
