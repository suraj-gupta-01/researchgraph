"""
Test harness. Runs against a REAL PostgreSQL (schema.sql + the M2 and M4
migrations are applied to a throwaway `researchgraph_test` database),
because the whole point of the schema is what Postgres does with it. MongoDB is replaced by
mongomock, which has no $text support, so the abstract-search channel is
stood in for by a small pure-Python matcher with the same AND semantics.

    docker compose exec backend pytest
"""
from __future__ import annotations

import os
import pathlib

import psycopg2
import pytest

TEST_DB = "researchgraph_test"
os.environ["POSTGRES_DB"] = TEST_DB           # must be set before app.* is imported
# Data-endpoint tests run without sign-in; test_auth.py switches it on.
os.environ["AUTH_ENABLED"] = "false"

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _admin_conn():
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        user=os.getenv("POSTGRES_USER", "researchgraph"),
        password=os.getenv("POSTGRES_PASSWORD", "researchgraph"),
        dbname="postgres",
    )


@pytest.fixture(scope="session")
def _database():
    try:
        admin = _admin_conn()
    except psycopg2.OperationalError as exc:
        pytest.skip(f"PostgreSQL not reachable: {exc}")
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f"DROP DATABASE IF EXISTS {TEST_DB}")
        cur.execute(f"CREATE DATABASE {TEST_DB}")
    admin.close()

    conn = psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        user=os.getenv("POSTGRES_USER", "researchgraph"),
        password=os.getenv("POSTGRES_PASSWORD", "researchgraph"),
        dbname=TEST_DB,
    )
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute((ROOT / "database" / "schema.sql").read_text())
        cur.execute((ROOT / "database" / "migrations" / "02_m2.sql").read_text())
        cur.execute((ROOT / "database" / "migrations" / "03_m4.sql").read_text())
        cur.execute((ROOT / "database" / "migrations" / "04_m4_part3.sql").read_text())
        cur.execute((ROOT / "database" / "migrations" / "05_m4_part4.sql").read_text())
        cur.execute((ROOT / "database" / "migrations" / "06_query_lab.sql").read_text())
    conn.close()
    yield


@pytest.fixture(scope="session")
def mongo(_database):
    """One shared in-memory Mongo, wired into both the loader and the API."""
    import mongomock

    from app import mongo_store
    import graph.build_graph as build_graph
    import graph.communities as communities
    import graph.convergence as convergence
    import graph.influence as influence
    import graph.trends as trends
    import ingestion.extract_topics as extract_topics
    import ingestion.loader as loader
    import ingestion.validate_provenance as validate_provenance

    db = mongomock.MongoClient()["researchgraph_test"]
    mp = pytest.MonkeyPatch()
    mp.setattr(mongo_store, "get_mongo_db", lambda: db)
    mp.setattr(loader, "get_mongo_db", lambda: db)
    mp.setattr(extract_topics, "get_mongo_db", lambda: db)
    mp.setattr(build_graph, "get_mongo_db", lambda: db)
    mp.setattr(communities, "get_mongo_db", lambda: db)
    mp.setattr(trends, "get_mongo_db", lambda: db)
    mp.setattr(influence, "get_mongo_db", lambda: db)
    mp.setattr(convergence, "get_mongo_db", lambda: db)
    mp.setattr(validate_provenance, "get_mongo_db", lambda: db)

    def fake_text_search(q: str, limit: int = 2000) -> dict[int, float]:
        tokens = mongo_store.query_tokens(q)
        found: dict[int, float] = {}
        for d in db[mongo_store.COLLECTION].find({}):
            blob = " ".join([d.get("abstract") or ""] + list(d.get("keywords") or [])).lower()
            if tokens and all(t in blob for t in tokens):
                found[d["paper_id"]] = 1.0
        return found

    mp.setattr(mongo_store, "text_search", fake_text_search)
    yield db
    mp.undo()


@pytest.fixture(scope="session")
def dataset(mongo):
    from ingestion.seed_dev import build_dataset

    return build_dataset()


@pytest.fixture(scope="session")
def seeded(dataset):
    """Loads the synthetic corpus through the real loader path once."""
    from ingestion.derive_collaboration import derive_collaboration
    from ingestion.loader import link_citations, load_papers

    stats = load_papers(dataset)
    linked = link_citations(dataset)
    collab = derive_collaboration()
    return {"stats": stats, "citations": linked, "collab": collab}


@pytest.fixture(scope="session")
def engine(seeded):
    from app.db import get_engine

    return get_engine()


@pytest.fixture(scope="session")
def client(seeded):
    from fastapi.testclient import TestClient

    from app.main import app

    # Not used as a context manager on purpose: skip the lifespan, which would
    # try to build a $text index that mongomock does not implement.
    return TestClient(app)


def q(engine, sql, **params):
    from sqlalchemy import text

    with engine.connect() as conn:
        return conn.execute(text(sql), params).all()
