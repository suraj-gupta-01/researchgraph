from collections.abc import Iterator
from functools import lru_cache

from pymongo import MongoClient
from pymongo.database import Database
from sqlalchemy import create_engine
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import sessionmaker

from app.config import settings


@lru_cache
def get_engine() -> Engine:
    return create_engine(settings.postgres_dsn, pool_pre_ping=True)


SessionLocal = sessionmaker(bind=get_engine(), autoflush=False, autocommit=False)


@lru_cache
def get_mongo_client() -> MongoClient:
    return MongoClient(settings.mongo_uri)


def get_mongo_db() -> Database:
    return get_mongo_client()[settings.mongo_db]


def get_conn() -> Iterator[Connection]:
    """FastAPI dependency: one pooled Postgres connection per request.
    The API is read-only in M2, so nothing is committed; the connection is
    rolled back and returned to the pool on exit."""
    with get_engine().connect() as conn:
        yield conn
