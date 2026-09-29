"""
Cross-source entity resolution (Section 6.2, and the #1 risk in Section 11).

Merge strategy, in priority order:
  Papers:       DOI  ->  fuzzy title match (+ same year) -> review queue
  Authors:      ORCID -> fuzzy name match (+ shared paper) -> review queue
  Institutions: ROR ID -> fuzzy name match (+ same country) -> review queue

Anything below a confidence threshold is written to ENTITY_RESOLUTION_QUEUE
for manual review rather than auto-merged — the PRD explicitly calls out
that naive DOI-only matching is not enough to trust blindly.
"""
from __future__ import annotations

from dataclasses import asdict

from rapidfuzz import fuzz

from ingestion.common_schema import NormalizedAuthor, NormalizedInstitution, NormalizedPaper

TITLE_MATCH_THRESHOLD = 92       # rapidfuzz token_sort_ratio, 0-100
NAME_MATCH_THRESHOLD = 90
INSTITUTION_MATCH_THRESHOLD = 88
REVIEW_QUEUE_FLOOR = 75          # below this, don't even queue — too noisy to be useful


class ResolutionResult:
    """Outcome of trying to resolve `candidate` against an existing pool."""

    def __init__(
        self,
        matched_key: str | None,
        confidence: float,
        queued: bool = False,
        candidate_key: str | None = None,
    ):
        self.matched_key = matched_key      # canonical key to merge into, or None
        self.confidence = confidence
        self.queued = queued                # True if written to the review queue instead of auto-merged
        self.candidate_key = candidate_key  # best-scoring existing key, even when only queued for review


def resolve_paper(
    candidate: NormalizedPaper,
    existing_by_doi: dict[str, str],
    existing_titles: dict[str, tuple[str, int]],  # canonical_key -> (title, year)
) -> ResolutionResult:
    """existing_by_doi / existing_titles represent papers already loaded
    from a previously-processed source, keyed by our internal canonical key
    (e.g. Paper_ID once persisted, or a temp key mid-batch)."""

    if candidate.doi and candidate.doi in existing_by_doi:
        return ResolutionResult(existing_by_doi[candidate.doi], confidence=1.0)

    best_key, best_score = None, 0.0
    for key, (title, year) in existing_titles.items():
        if year != candidate.publication_year:
            continue
        score = fuzz.token_sort_ratio(title.lower(), candidate.title.lower())
        if score > best_score:
            best_key, best_score = key, score

    if best_score >= TITLE_MATCH_THRESHOLD:
        return ResolutionResult(best_key, confidence=best_score / 100)
    if best_score >= REVIEW_QUEUE_FLOOR:
        return ResolutionResult(None, confidence=best_score / 100, queued=True, candidate_key=best_key)
    return ResolutionResult(None, confidence=best_score / 100)


def resolve_author(
    candidate: NormalizedAuthor,
    existing_by_orcid: dict[str, str],
    existing_names: dict[str, str],          # canonical_key -> full_name
    shared_paper_hint: bool = False,
) -> ResolutionResult:
    """shared_paper_hint: True when the candidate co-occurs with an existing
    author record on a paper already matched by DOI — this raises confidence
    for an otherwise-ambiguous name match (common surnames, etc.)."""

    if candidate.orcid and candidate.orcid in existing_by_orcid:
        return ResolutionResult(existing_by_orcid[candidate.orcid], confidence=1.0)

    best_key, best_score = None, 0.0
    for key, name in existing_names.items():
        score = fuzz.token_sort_ratio(name.lower(), candidate.full_name.lower())
        if score > best_score:
            best_key, best_score = key, score

    effective_threshold = NAME_MATCH_THRESHOLD - (10 if shared_paper_hint else 0)

    if best_score >= effective_threshold:
        return ResolutionResult(best_key, confidence=best_score / 100)
    if best_score >= REVIEW_QUEUE_FLOOR:
        return ResolutionResult(None, confidence=best_score / 100, queued=True, candidate_key=best_key)
    return ResolutionResult(None, confidence=best_score / 100)


def resolve_institution(
    candidate: NormalizedInstitution,
    existing_by_ror: dict[str, str],
    existing_names: dict[str, tuple[str, str | None]],  # canonical_key -> (name, country)
) -> ResolutionResult:
    if candidate.ror_id and candidate.ror_id in existing_by_ror:
        return ResolutionResult(existing_by_ror[candidate.ror_id], confidence=1.0)

    best_key, best_score = None, 0.0
    for key, (name, country) in existing_names.items():
        if candidate.country and country and candidate.country != country:
            continue
        score = fuzz.token_sort_ratio(name.lower(), candidate.name.lower())
        if score > best_score:
            best_key, best_score = key, score

    if best_score >= INSTITUTION_MATCH_THRESHOLD:
        return ResolutionResult(best_key, confidence=best_score / 100)
    if best_score >= REVIEW_QUEUE_FLOOR:
        return ResolutionResult(None, confidence=best_score / 100, queued=True, candidate_key=best_key)
    return ResolutionResult(None, confidence=best_score / 100)


def build_review_queue_entry(entity_type: str, candidate_a: dict, candidate_b: dict, confidence: float) -> dict:
    """Shape matching ENTITY_RESOLUTION_QUEUE — hand this to loader.py to insert."""
    return {
        "entity_type": entity_type,
        "candidate_a": candidate_a,
        "candidate_b": candidate_b,
        "match_confidence": round(confidence, 4),
        "status": "pending",
    }


def paper_to_review_dict(paper: NormalizedPaper) -> dict:
    d = asdict(paper)
    d.pop("raw_response", None)   # keep the queue table lightweight; raw stays in Mongo
    d.pop("embedding", None)
    return d
