"""
Start-up step for the one-command demo (Phase 9): `docker compose up` on an
empty volume should end with a working, populated dashboard.

Runs before uvicorn (see the Dockerfile CMD):

  1. Upgrades an older database volume in place with the query-lab objects
     (06_query_lab.sql is CREATE OR REPLACE throughout, so re-applying it is
     safe). A fresh volume already got it from docker-entrypoint-initdb.d.
  2. If PAPER is empty and SEED_ON_EMPTY is true (the default), loads the
     synthetic dev corpus and runs every analysis (ingestion.seed_dev). A
     non-empty database is never touched, so real data from run_ingestion
     survives restarts. Set SEED_ON_EMPTY=false to start empty instead.

Never fatal: if anything here fails, the API still starts and /health and
the empty states say what is missing.
"""
from __future__ import annotations

import logging
import os
import pathlib

from sqlalchemy import text

from app.db import get_engine

log = logging.getLogger("researchgraph.bootstrap")

MIGRATION = pathlib.Path(os.getenv("QUERY_LAB_SQL", "/database/migrations/06_query_lab.sql"))


def ensure_query_lab_objects() -> None:
    with get_engine().connect() as conn:
        present = conn.execute(text("SELECT to_regprocedure('fn_topic_authors(integer,integer,integer,numeric)') IS NOT NULL")).scalar_one()
    if present:
        return
    if not MIGRATION.exists():
        log.warning("Query-lab views are missing and %s is not mounted; apply it with psql to enable /queries", MIGRATION)
        return
    with get_engine().begin() as conn:
        conn.exec_driver_sql(MIGRATION.read_text())
    log.info("Applied %s to an existing database", MIGRATION.name)


def seed_if_empty() -> None:
    if os.getenv("SEED_ON_EMPTY", "true").strip().lower() in ("0", "false", "no", "off"):
        return
    with get_engine().connect() as conn:
        papers = conn.execute(text("SELECT COUNT(*) FROM PAPER")).scalar_one()
    if papers:
        log.info("Database has %d papers; not seeding", papers)
        return
    log.info("Empty database: loading the synthetic dev corpus (SEED_ON_EMPTY=true)")
    from ingestion.seed_dev import main as seed_main

    seed_main()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for step in (ensure_query_lab_objects, seed_if_empty):
        try:
            step()
        except Exception:                # noqa: BLE001 -- start the API regardless
            log.exception("Bootstrap step %s failed; starting the API anyway", step.__name__)


if __name__ == "__main__":
    main()
