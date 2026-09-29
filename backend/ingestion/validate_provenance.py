"""
M3 — Part 3: provenance / merge-logic validation across sources (PRD 6.2, 11).

Entity resolution across OpenAlex and Semantic Scholar is the PRD's own
"highest-risk piece" (Section 11): a wrong merge silently corrupts every
graph M4 will build. This module is the safety net. It is READ-ONLY: it
never repairs anything, it audits what the loader left behind and reports
invariants that must hold after any ingestion run.

Every check returns one of:
  pass    - invariant holds
  fail    - a merge/provenance bug (or corrupted data); CLI exits non-zero
  warn    - suspicious but can be legitimate real-world data
  skipped - could not be evaluated (missing table/column/data); the detail
            says exactly why, so a skip is never mistaken for a pass

Checks (each one traces back to a bug class fixed in M1, see README):
  paper_source_coverage      every PAPER has >=1 PAPER_SOURCE row
  paper_source_unique        one (source, record id) never maps to 2 papers
  paper_source_id_columns    PAPER.Openalex_/Semantic_Scholar_Paper_ID agree
                             with PAPER_SOURCE (M1 fix #4)
  doi_lowercase / doi_unique DOI case normalisation; no duplicate works
  orcid_format / orcid_unique  bare ORCID form; one ORCID = one author
  author_source_ids_unique   one source author id never on 2 authors
  author_cross_source_evidence  an author holding BOTH source ids must be
                             justified by a shared multi-source paper or an ORCID
                             (M1 fix #3)
  same_name_coauthors        two same-name authors on one paper (warn)
  citation_integrity         no self-citations
  citation_chronology        cited work newer than citing work (warn)
  citation_count_nonnegative counts are never negative
  citation_count_provenance  reconciled Citation_Count traces to
                             PAPER_SOURCE.Source_Citation_Count (S2 preferred)
  resolution_queue_pending   low-confidence matches still awaiting review (warn)

Table/column names are discovered from the live catalog rather than
hard-coded, so a rename shows up as an explicit `skipped` with the columns
that were found, not as a crash or a false pass.

    docker compose exec backend python -m ingestion.validate_provenance
"""
from __future__ import annotations

import logging
import re
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from sqlalchemy import inspect, text
from sqlalchemy.engine import Row

from app.db import get_engine, get_mongo_db

log = logging.getLogger("researchgraph.validate_provenance")

PASS, FAIL, WARN, SKIP = "pass", "fail", "warn", "skipped"

# PRD 6.2: prefer Semantic Scholar's citation count, fall back to OpenAlex.
PREFERRED_SOURCE = "semantic_scholar"
ORCID_RE = re.compile(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$")
MAX_EXAMPLES = 5
_IDENT = re.compile(r"^\w+$")


@dataclass
class Check:
    name: str
    status: str
    detail: str
    count: int = 0
    examples: list = field(default_factory=list)


# --------------------------------------------------------------------------
# schema discovery
# --------------------------------------------------------------------------

def _ident(name: str) -> str:
    """Identifiers come from the DB catalog, never from a request, but assert
    the shape anyway before they are interpolated into SQL."""
    if not _IDENT.match(name):
        raise ValueError(f"unexpected identifier {name!r}")
    return name


def _pick(cols: dict[str, str], *candidates: str) -> str | None:
    for c in candidates:
        if c in cols:
            return cols[c]
    return None


def discover_schema(conn) -> dict:
    insp = inspect(conn)
    tables = {t.lower(): t for t in insp.get_table_names()}

    def cols(table: str) -> tuple[str | None, dict[str, str]]:
        real = tables.get(table)
        if not real:
            return None, {}
        return real, {c["name"].lower(): c["name"] for c in insp.get_columns(real)}

    s: dict = {}

    t, c = cols("paper")
    s["paper"] = {"table": t, "id": _pick(c, "paper_id"), "doi": _pick(c, "doi"),
                  "citation_count": _pick(c, "citation_count"), "year": _pick(c, "publication_year"),
                  "source_id_cols": {"openalex": _pick(c, "openalex_paper_id"),
                                     "semantic_scholar": _pick(c, "semantic_scholar_paper_id")},
                  "columns": sorted(c)}

    t, c = cols("paper_source")
    s["paper_source"] = {"table": t, "paper_id": _pick(c, "paper_id"),
                         "source": _pick(c, "source_name", "source"),
                         "record": _pick(c, "source_record_id", "source_paper_id", "record_id"),
                         "count": _pick(c, "source_citation_count"),
                         "columns": sorted(c)}

    t, c = cols("author")
    s["author"] = {"table": t, "id": _pick(c, "author_id"), "name": _pick(c, "full_name"),
                   "orcid": _pick(c, "orcid", "orcid_id"),
                   "source_id_cols": {"openalex": _pick(c, "openalex_author_id"),
                                      "semantic_scholar": _pick(c, "semantic_scholar_author_id")},
                   "columns": sorted(c)}

    t, c = cols("authorship")
    s["authorship"] = {"table": t, "author_id": _pick(c, "author_id"), "paper_id": _pick(c, "paper_id")}

    t, c = cols("citation")
    s["citation"] = {"table": t, "citing": _pick(c, "citing_paper_id"), "cited": _pick(c, "cited_paper_id")}

    t, c = cols("entity_resolution_queue")
    s["queue"] = {"table": t, "status": _pick(c, "status")}
    return s


def _complete(section: dict, *keys: str) -> bool:
    return bool(section.get("table")) and all(section.get(k) for k in keys)


def _short(rows, n: int = MAX_EXAMPLES) -> list:
    # SQLAlchemy 2.x Row is not a tuple subclass; left as-is it cannot be
    # BSON-encoded and the Mongo report write fails.
    return [[x if isinstance(x, (int, float, str)) or x is None else str(x) for x in r]
            if isinstance(r, (tuple, list, Row)) else r for r in list(rows)[:n]]


# --------------------------------------------------------------------------
# paper-level checks
# --------------------------------------------------------------------------

def _paper_checks(conn, s) -> tuple[list[Check], dict]:
    p = s["paper"]
    checks: list[Check] = []
    stats: dict = {}
    if not _complete(p, "id"):
        return [Check("paper_table", FAIL, f"PAPER table/Paper_ID not found (columns: {p.get('columns')})")], stats

    pid, tbl = _ident(p["id"]), _ident(p["table"])
    all_ids = {r[0] for r in conn.execute(text(f"SELECT {pid} FROM {tbl}"))}
    stats["papers"] = len(all_ids)

    # --- DOI hygiene -------------------------------------------------------
    if p.get("doi"):
        doi = _ident(p["doi"])
        rows = conn.execute(text(f"SELECT {pid}, {doi} FROM {tbl} WHERE {doi} IS NOT NULL")).all()
        bad_case = [(i, d) for i, d in rows if d != d.strip().lower()]
        checks.append(Check(
            "doi_lowercase", FAIL if bad_case else PASS,
            "DOIs must be stored lower-cased and trimmed (M1 fix #5)" if bad_case else "all DOIs normalised",
            len(bad_case), _short(bad_case)))
        by_doi: dict[str, list[int]] = defaultdict(list)
        for i, d in rows:
            by_doi[d.strip().lower()].append(i)
        dupes = {d: ids for d, ids in by_doi.items() if len(ids) > 1}
        checks.append(Check(
            "doi_unique", FAIL if dupes else PASS,
            "the same DOI (case-insensitive) appears on more than one PAPER: an unmerged duplicate"
            if dupes else "no DOI is shared by two papers",
            len(dupes), _short([(d, ids) for d, ids in dupes.items()])))
        stats["papers_with_doi"] = len(rows)
    else:
        checks.append(Check("doi_lowercase", SKIP, "PAPER has no DOI column"))
        checks.append(Check("doi_unique", SKIP, "PAPER has no DOI column"))

    # --- PAPER_SOURCE provenance ------------------------------------------
    ps = s["paper_source"]
    if not _complete(ps, "paper_id", "source", "record"):
        detail = (f"PAPER_SOURCE not usable (table={ps.get('table')}, columns={ps.get('columns')}); "
                  "expected paper_id, source_name, source_record_id (PRD 6.2)")
        for n in ("paper_source_coverage", "paper_source_unique", "paper_source_id_columns"):
            checks.append(Check(n, SKIP, detail))
        return checks, stats

    t2, c_pid, c_src, c_rec = (_ident(ps[k]) for k in ("table", "paper_id", "source", "record"))
    rows = conn.execute(text(f"SELECT {c_pid}, {c_src}, {c_rec} FROM {t2}")).all()

    covered = {r[0] for r in rows}
    orphans = sorted(all_ids - covered)
    checks.append(Check(
        "paper_source_coverage", FAIL if orphans else PASS,
        "papers with no provenance row: source of the record is unknown (PRD 6.2)" if orphans
        else "every paper has at least one source", len(orphans), orphans[:MAX_EXAMPLES]))

    by_key: dict[tuple, set[int]] = defaultdict(set)
    per_paper: dict[int, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for paper, src, rec in rows:
        by_key[(src, rec)].add(paper)
        per_paper[paper][src].add(rec)
    collisions = {k: sorted(v) for k, v in by_key.items() if len(v) > 1}
    checks.append(Check(
        "paper_source_unique", FAIL if collisions else PASS,
        "one source record maps to several papers: a wrong merge" if collisions
        else "each (source, record id) maps to exactly one paper",
        len(collisions), _short([(k[0], k[1], v) for k, v in collisions.items()])))

    # PAPER.<Source>_Paper_ID columns duplicate what PAPER_SOURCE says. They
    # must agree, and a NULL column next to a PAPER_SOURCE row means the
    # source's id never got recorded on the merged paper (M1 fix #4).
    id_cols = {k: v for k, v in p.get("source_id_cols", {}).items() if v}
    if id_cols:
        cols_sql = ", ".join(_ident(v) for v in id_cols.values())
        stored = {r[0]: dict(zip(id_cols, r[1:])) for r in conn.execute(text(f"SELECT {pid}, {cols_sql} FROM {tbl}"))}
        mismatched = []
        for paper, src, rec in rows:
            if src in id_cols and paper in stored and stored[paper].get(src) != rec:
                mismatched.append((paper, src, rec, stored[paper].get(src)))
        checks.append(Check(
            "paper_source_id_columns", FAIL if mismatched else PASS,
            "PAPER's per-source id column disagrees with PAPER_SOURCE (paper, source, provenance id, column value)"
            if mismatched else "PAPER id columns agree with PAPER_SOURCE", len(mismatched), _short(mismatched)))
    else:
        checks.append(Check("paper_source_id_columns", SKIP, "PAPER has no per-source id columns"))

    src_counts: dict[str, int] = defaultdict(int)
    for d in per_paper.values():
        for src in d:
            src_counts[src] += 1
    stats["papers_by_source"] = dict(src_counts)
    stats["papers_in_multiple_sources"] = sum(1 for d in per_paper.values() if len(d) > 1)
    return checks, stats


# --------------------------------------------------------------------------
# author-level checks
# --------------------------------------------------------------------------

def _author_checks(conn, s) -> tuple[list[Check], dict]:
    a = s["author"]
    checks: list[Check] = []
    stats: dict = {}
    if not _complete(a, "id"):
        return [Check("author_table", FAIL, f"AUTHOR table/Author_ID not found (columns: {a.get('columns')})")], stats
    aid, atbl = _ident(a["id"]), _ident(a["table"])
    stats["authors"] = conn.execute(text(f"SELECT COUNT(*) FROM {atbl}")).scalar_one()

    # --- ORCID ------------------------------------------------------------
    if a.get("orcid"):
        orc = _ident(a["orcid"])
        rows = conn.execute(text(f"SELECT {aid}, {orc} FROM {atbl} WHERE {orc} IS NOT NULL AND {orc} <> ''")).all()
        stats["authors_with_orcid"] = len(rows)
        bad = [(i, o) for i, o in rows if not ORCID_RE.match(o.strip())]
        checks.append(Check(
            "orcid_format", FAIL if bad else PASS,
            "ORCIDs must be stored in bare 0000-0000-0000-000X form, not as URLs (M1 fix #2)" if bad
            else "all ORCIDs are in bare form", len(bad), _short(bad)))
        by_orcid: dict[str, list[int]] = defaultdict(list)
        for i, o in rows:
            by_orcid[o.strip().upper()].append(i)
        dupes = {o: ids for o, ids in by_orcid.items() if len(ids) > 1}
        checks.append(Check(
            "orcid_unique", FAIL if dupes else PASS,
            "one ORCID on several authors: an unmerged duplicate person" if dupes
            else "every ORCID identifies one author",
            len(dupes), _short([(o, ids) for o, ids in dupes.items()])))
    else:
        for n in ("orcid_format", "orcid_unique"):
            checks.append(Check(n, SKIP, f"AUTHOR has no ORCID column (columns: {a.get('columns')})"))

    # --- per-source author ids --------------------------------------------
    id_cols = {k: v for k, v in a.get("source_id_cols", {}).items() if v}
    if id_cols:
        cols_sql = ", ".join(_ident(v) for v in id_cols.values())
        rows = conn.execute(text(f"SELECT {aid}, {cols_sql} FROM {atbl}")).all()
        dupes = []
        for i, (src, _col) in enumerate(id_cols.items(), start=1):
            by_id: dict[str, list[int]] = defaultdict(list)
            for r in rows:
                if r[i]:
                    by_id[r[i]].append(r[0])
            dupes += [(src, k, v) for k, v in by_id.items() if len(v) > 1]
        checks.append(Check(
            "author_source_ids_unique", FAIL if dupes else PASS,
            "one source author id sits on several authors: an unmerged duplicate" if dupes
            else "every source author id identifies one author", len(dupes), _short(dupes)))
        stats["authors_by_source"] = {src: sum(1 for r in rows if r[i]) for i, src in enumerate(id_cols, start=1)}
        both = [r[0] for r in rows if all(r[i] for i in range(1, len(id_cols) + 1))] if len(id_cols) > 1 else []
        stats["authors_in_multiple_sources"] = len(both)

        # An author holding BOTH source ids was merged across sources. The
        # loader only allows that through an ORCID or through a fuzzy name
        # match restricted to a paper both sources report (M1 fix #3). So a
        # both-ids author with no ORCID and no such paper has no evidence.
        au, ps = s["authorship"], s["paper_source"]
        if len(id_cols) > 1 and _complete(au, "author_id", "paper_id") and _complete(ps, "paper_id", "source"):
            orc = f"a.{_ident(a['orcid'])} IS NULL AND " if a.get("orcid") else ""
            conds = " AND ".join(f"a.{_ident(v)} IS NOT NULL" for v in id_cols.values())
            unsupported = conn.execute(text(
                f"SELECT a.{aid} FROM {atbl} a WHERE {conds} AND {orc}NOT EXISTS ("
                f"SELECT 1 FROM {_ident(au['table'])} x WHERE x.{_ident(au['author_id'])} = a.{aid} AND ("
                f"SELECT COUNT(DISTINCT p.{_ident(ps['source'])}) FROM {_ident(ps['table'])} p "
                f"WHERE p.{_ident(ps['paper_id'])} = x.{_ident(au['paper_id'])}) >= 2)"
            )).all()
            ids = [r[0] for r in unsupported]
            checks.append(Check(
                "author_cross_source_evidence", FAIL if ids else PASS,
                "author holds both sources' ids but has no ORCID and no paper reported by both sources: "
                "likely two different people merged" if ids
                else "every cross-source author merge has ORCID or shared-paper evidence", len(ids), ids[:MAX_EXAMPLES]))
        else:
            checks.append(Check("author_cross_source_evidence", SKIP, "needs two source id columns, AUTHORSHIP and PAPER_SOURCE"))
    else:
        for n in ("author_source_ids_unique", "author_cross_source_evidence"):
            checks.append(Check(n, SKIP, f"AUTHOR has no per-source id columns (columns: {a.get('columns')})"))

    # --- same-name authors on one paper ------------------------------------
    au = s["authorship"]
    if _complete(a, "name") and _complete(au, "author_id", "paper_id"):
        name, t = _ident(a["name"]), _ident(au["table"])
        rows = conn.execute(text(
            f"SELECT x.{_ident(au['paper_id'])}, LOWER(a.{name}) AS n, COUNT(*) "
            f"FROM {t} x JOIN {atbl} a ON a.{aid} = x.{_ident(au['author_id'])} "
            f"GROUP BY x.{_ident(au['paper_id'])}, LOWER(a.{name}) HAVING COUNT(*) > 1")).all()
        checks.append(Check(
            "same_name_coauthors", WARN if rows else PASS,
            "two author rows with one name on one paper: either an unmerged duplicate or two real people "
            "(the dev corpus has two 'Wei Zhang's on purpose)" if rows else "no paper lists one name twice",
            len(rows), _short(rows)))
    else:
        checks.append(Check("same_name_coauthors", SKIP, "AUTHOR/AUTHORSHIP columns not found"))
    return checks, stats


# --------------------------------------------------------------------------
# citation checks
# --------------------------------------------------------------------------

def _citation_checks(conn, s) -> tuple[list[Check], dict]:
    c, p = s["citation"], s["paper"]
    if not _complete(c, "citing", "cited"):
        return [Check("citation_integrity", SKIP, "CITATION columns not found")], {}
    t, a, b = _ident(c["table"]), _ident(c["citing"]), _ident(c["cited"])
    total = conn.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar_one()
    self_cites = conn.execute(text(f"SELECT {a}, {b} FROM {t} WHERE {a} = {b}")).all()
    checks = [Check("citation_integrity", FAIL if self_cites else PASS,
                    "a paper cites itself: usually two records of one work merged wrongly" if self_cites
                    else "no self-citations", len(self_cites), _short(self_cites))]

    if _complete(p, "id", "year"):
        pt, pid, yr = _ident(p["table"]), _ident(p["id"]), _ident(p["year"])
        rows = conn.execute(text(
            f"SELECT c.{a}, c.{b}, x.{yr}, y.{yr} FROM {t} c JOIN {pt} x ON x.{pid} = c.{a} "
            f"JOIN {pt} y ON y.{pid} = c.{b} WHERE x.{yr} > 0 AND y.{yr} > x.{yr}")).all()
        checks.append(Check(
            "citation_chronology", WARN if rows else PASS,
            "cited work is newer than the citing work (preprint-vs-final year skew is common, so warn only)"
            if rows else "no citation points forward in time", len(rows), _short(rows)))
    else:
        checks.append(Check("citation_chronology", SKIP, "PAPER has no publication-year column"))
    return checks, {"citations": total}


# --------------------------------------------------------------------------
# citation-count provenance + review queue
# --------------------------------------------------------------------------

def _citation_count_checks(conn, s) -> list[Check]:
    p, ps = s["paper"], s["paper_source"]
    out: list[Check] = []
    if not _complete(p, "id", "citation_count"):
        return [Check("citation_count_nonnegative", SKIP, "PAPER has no Citation_Count column"),
                Check("citation_count_provenance", SKIP, "PAPER has no Citation_Count column")]
    pt, pid, cc = _ident(p["table"]), _ident(p["id"]), _ident(p["citation_count"])
    stored = {r[0]: r[1] for r in conn.execute(text(f"SELECT {pid}, {cc} FROM {pt}"))}

    neg = [(i, v) for i, v in stored.items() if v is not None and v < 0]
    out.append(Check("citation_count_nonnegative", FAIL if neg else PASS,
                     "a citation count is negative" if neg else "no negative citation counts", len(neg), _short(neg)))

    if not _complete(ps, "paper_id", "source", "count"):
        out.append(Check("citation_count_provenance", SKIP,
                         "PAPER_SOURCE has no Source_Citation_Count, so a merged count cannot be traced to a source"))
        return out
    t, c_p, c_s, c_c = (_ident(ps[k]) for k in ("table", "paper_id", "source", "count"))
    per: dict[int, dict[str, int]] = defaultdict(dict)
    for paper, src, cnt in conn.execute(text(f"SELECT {c_p}, {c_s}, {c_c} FROM {t} WHERE {c_c} IS NOT NULL")):
        per[paper][src] = cnt
    untraceable, not_preferred = [], []
    for paper, by_src in per.items():
        value = stored.get(paper)
        if value is None:
            continue
        if value not in by_src.values():
            untraceable.append((paper, value, by_src))
        elif PREFERRED_SOURCE in by_src and by_src[PREFERRED_SOURCE] != value:
            not_preferred.append((paper, value, by_src))
    if untraceable:
        out.append(Check("citation_count_provenance", FAIL,
                         "PAPER.Citation_Count equals no source's Source_Citation_Count: it cannot be traced",
                         len(untraceable), _short(untraceable)))
    elif not_preferred:
        out.append(Check("citation_count_provenance", WARN,
                         f"Citation_Count differs from {PREFERRED_SOURCE}, the preferred source (PRD 6.2); the loader "
                         "lets OpenAlex overwrite a zero", len(not_preferred), _short(not_preferred)))
    else:
        out.append(Check("citation_count_provenance", PASS,
                         f"every reconciled count traces to a source and follows the {PREFERRED_SOURCE} preference"
                         if per else "no per-source counts recorded yet", len(per)))
    return out


def _queue_check(conn, s) -> Check:
    q = s["queue"]
    if not _complete(q, "status"):
        return Check("resolution_queue_pending", SKIP, "ENTITY_RESOLUTION_QUEUE not found")
    pending = conn.execute(text(
        f"SELECT COUNT(*) FROM {_ident(q['table'])} WHERE {_ident(q['status'])} = 'pending'")).scalar_one()
    return Check("resolution_queue_pending", WARN if pending else PASS,
                 "low-confidence merge candidates are waiting for review; they were NOT merged (PRD 6.2)"
                 if pending else "review queue is empty", pending)


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------

def _run(conn) -> dict:
    s = discover_schema(conn)
    checks: list[Check] = []
    stats: dict = {}
    for fn in (_paper_checks, _author_checks, _citation_checks):
        c, st = fn(conn, s)
        checks += c
        stats.update(st)
    checks += _citation_count_checks(conn, s)
    checks.append(_queue_check(conn, s))

    counts = {k: sum(1 for c in checks if c.status == k) for k in (PASS, FAIL, WARN, SKIP)}
    return {
        "validated_at": datetime.now(timezone.utc).isoformat(),
        "ok": counts[FAIL] == 0,
        "counts": counts,
        "stats": stats,
        "schema": {"author_orcid_column": s["author"].get("orcid"),
                   "paper_source_table": s["paper_source"].get("table"),
                   "paper_source_count_column": s["paper_source"].get("count")},
        "checks": [asdict(c) for c in checks],
    }


def run_validation(conn=None, persist: bool = True) -> dict:
    """Run every check. Pass `conn` to validate inside an existing
    transaction (the tests do, to inject a corruption and roll it back)."""
    if conn is None:
        with get_engine().connect() as c:
            report = _run(c)
    else:
        report = _run(conn)
    if persist:
        try:
            get_mongo_db()["graph_snapshot"].replace_one(
                {"_id": "provenance"}, {"_id": "provenance", **report}, upsert=True)
        except Exception:  # noqa: BLE001
            log.warning("Could not persist provenance report to MongoDB", exc_info=True)
    level = logging.INFO if report["ok"] else logging.ERROR
    log.log(level, "Provenance validation: ok=%s counts=%s stats=%s", report["ok"], report["counts"], report["stats"])
    for c in report["checks"]:
        if c["status"] in (FAIL, WARN):
            log.log(logging.ERROR if c["status"] == FAIL else logging.WARNING,
                    "  [%s] %s: %s (n=%d) e.g. %s", c["status"], c["name"], c["detail"], c["count"], c["examples"])
    return report


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    report = run_validation()
    icon = {PASS: "PASS", FAIL: "FAIL", WARN: "WARN", SKIP: "SKIP"}
    for c in report["checks"]:
        print(f"[{icon[c['status']]}] {c['name']:<40} {c['detail']}" + (f"  (n={c['count']})" if c["count"] else ""))
    print(f"\n{report['counts']}  stats={report['stats']}")
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
