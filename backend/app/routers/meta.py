"""
G4 -- runs and methods (F6 auditability, PRD Section 8: "trend/community
detection runs should be timestamped and re-producible").

Every analysis job upserts a run summary into MongoDB `graph_snapshot`
(`_id` = latest [graph build] / communities / trends / convergence /
influence / provenance). Four of them also stamp Algorithm + Detection_Date
on their Postgres rows, which stay authoritative for the results; this
endpoint reports both, so a run whose Mongo summary is missing (Mongo down,
or an older job version) still shows its algorithm and date, and a summary
that belongs to a different run than the Postgres rows is flagged instead
of being presented as the method behind the data on screen.

Read-only; every SQL string below is a module constant.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Connection

from app import mongo_store
from app.db import get_conn
from app.schemas import MetaRuns
from app.sqlutil import fetch_one

log = logging.getLogger("researchgraph.meta")

router = APIRouter(prefix="/meta", tags=["meta"])

# analysis name -> (Mongo snapshot _id, Postgres table stamped by the run or None)
ANALYSES: dict[str, tuple[str, str | None]] = {
    "graph": ("latest", None),
    "communities": ("communities", "RESEARCH_COMMUNITY"),
    "trends": ("trends", "RESEARCH_TREND"),
    "convergence": ("convergence", "TOPIC_PAIR_TREND"),
    "influence": ("influence", "AUTHOR_INFLUENCE"),
    "provenance": ("provenance", None),
}
_DATE_KEYS = ("detected_at", "built_at", "validated_at")
_SKIP_KEYS = {"_id", "algorithm", "params", "dry_run", "checks", *_DATE_KEYS}
# The same run writes Postgres and Mongo moments apart; anything further
# apart than this is a different run.
_SAME_RUN = timedelta(minutes=10)

_PG_SQL = {
    table: f"SELECT Algorithm AS algorithm, MAX(Detection_Date) AS detected_at, COUNT(*) AS rows "
    f"FROM {table} GROUP BY Algorithm ORDER BY MAX(Detection_Date) DESC LIMIT 1"
    for _, table in ANALYSES.values()
    if table
}


def _parse_date(v: Any) -> datetime | None:
    """ISO strings or BSON dates; naive values are UTC (pymongo's default)."""
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v)
        except ValueError:
            return None
    if not isinstance(v, datetime):
        return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _summarize(doc: dict) -> tuple[dict, dict]:
    """Split a snapshot into headline scalar counts and nested details
    (arrays are reduced to their length; they are result blobs, not run
    metadata)."""
    counts: dict[str, Any] = {}
    details: dict[str, Any] = {}
    for k, v in doc.items():
        if k in _SKIP_KEYS:
            continue
        if isinstance(v, bool) or isinstance(v, (int, float, str)):
            counts[k] = v
        elif isinstance(v, dict):
            details[k] = v
        elif isinstance(v, list):
            counts[f"{k}_count"] = len(v)
    return counts, details


@router.get("/runs", response_model=MetaRuns)
def runs(conn: Annotated[Connection, Depends(get_conn)]):
    """The last run of each analysis: algorithm string (with parameters),
    run date, parameters, headline counts, and, for provenance, every
    validation check with its status (`skipped` is its own status, never a
    pass). `status` per analysis:

      ok             Mongo summary present (and, where the run also stamps
                     Postgres, both agree on algorithm and date)
      not_run        no trace in either store
      postgres_only  results exist but the Mongo summary is missing
                     (Mongo unavailable, or the job predates run summaries)
      mismatch       the Mongo summary is from a different run than the
                     Postgres rows; the Postgres algorithm/date are shown
    """
    mongo_status = "ok"
    docs: dict[str, dict] = {}
    try:
        for d in mongo_store.run_snapshots([m for m, _ in ANALYSES.values()]):
            docs[d["_id"]] = d
    except Exception:                    # noqa: BLE001
        log.warning("graph_snapshot unavailable", exc_info=True)
        mongo_status = "unavailable"

    out = []
    for name, (mongo_id, table) in ANALYSES.items():
        doc = docs.get(mongo_id)
        pg = fetch_one(conn, _PG_SQL[table]) if table else None
        run: dict[str, Any] = {
            "analysis": name, "status": "not_run", "source": None, "algorithm": None,
            "detected_at": None, "params": {}, "counts": {}, "details": {},
            "postgres_rows": pg["rows"] if pg else (0 if table else None),
        }
        if doc:
            counts, details = _summarize(doc)
            run.update(
                status="ok", source="mongo", algorithm=doc.get("algorithm"),
                detected_at=next((_parse_date(doc[k]) for k in _DATE_KEYS if k in doc), None),
                params=doc.get("params") or {}, counts=counts, details=details,
            )
        if pg:
            if not doc:
                run.update(status="postgres_only", source="postgres", algorithm=pg["algorithm"], detected_at=pg["detected_at"])
            else:
                same_algo = doc.get("algorithm") in (None, pg["algorithm"])
                d = run["detected_at"]
                same_time = d is not None and abs(d - pg["detected_at"]) <= _SAME_RUN
                if not (same_algo and same_time):
                    run.update(status="mismatch", algorithm=pg["algorithm"], detected_at=pg["detected_at"])
        elif doc and table:
            # A summary with no result rows: the job ran but kept nothing
            # (e.g. no community reached min_size). Still a real run.
            run["status"] = "ok"
        out.append(run)

    checks = []
    prov = docs.get("provenance")
    if prov:
        checks = [
            {"name": c.get("name", "?"), "status": c.get("status", "unknown"), "detail": c.get("detail"), "count": c.get("count")}
            for c in prov.get("checks") or []
        ]
    return {"mongo": mongo_status, "runs": out, "provenance_checks": checks}
