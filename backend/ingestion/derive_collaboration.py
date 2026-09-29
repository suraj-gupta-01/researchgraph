"""
Populates COLLABORATION (institution pairs per paper), which M1 created but
never filled. An institution pair (A, B) is recorded for a paper when at
least two of that paper's authors are attributed to different institutions
(see the v_paper_institution view for how attribution is derived).

Idempotent: re-running only inserts missing rows. Called at the end of
run_ingestion and by ingestion.seed_dev.

Attribution is exact per paper: v_paper_institution reads
PAPER_AUTHOR_INSTITUTION (03_m4.sql), which replaced the earlier
per-(author, year) approximation.
"""
from __future__ import annotations

import logging

from sqlalchemy import text

from app.db import get_engine

log = logging.getLogger("researchgraph.collaboration")

_SQL = """
INSERT INTO COLLABORATION (Institution_A_ID, Institution_B_ID, Paper_ID)
SELECT DISTINCT a.Institution_ID, b.Institution_ID, a.Paper_ID
FROM v_paper_institution a
JOIN v_paper_institution b
  ON b.Paper_ID = a.Paper_ID AND a.Institution_ID < b.Institution_ID
ON CONFLICT DO NOTHING
"""


def derive_collaboration() -> int:
    with get_engine().begin() as conn:
        result = conn.execute(text(_SQL))
        inserted = result.rowcount
    log.info("COLLABORATION: %d new institution-pair rows", inserted)
    return inserted
