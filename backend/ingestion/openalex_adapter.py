"""
OpenAlex adapter (Section 6.2). No API key required; the 'polite pool'
mailto param raises the effective rate limit — set OPENALEX_MAILTO.

OpenAlex is the primary source for INSTITUTION / AUTHOR_INSTITUTION data
because it carries ROR IDs, which are a much cleaner merge key than fuzzy
institution-name matching.
"""
from __future__ import annotations

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from app.config import settings
from ingestion.common_schema import (
    NormalizedAuthor,
    NormalizedAuthorship,
    NormalizedInstitution,
    NormalizedPaper,
    NormalizedVenue,
)

BASE_URL = "https://api.openalex.org/works"
SOURCE_NAME = "openalex"


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=20))
def _get(client: httpx.Client, params: dict) -> dict:
    resp = client.get(BASE_URL, params=params)
    resp.raise_for_status()
    return resp.json()


def fetch_works_by_topic(topic_query: str, limit: int = 200) -> list[dict]:
    """Paginates through OpenAlex works matching a free-text topic search.
    Returns raw OpenAlex work objects — normalize separately so raw_response
    can still be preserved for MongoDB."""
    params = {
        "search": topic_query,
        "per_page": min(limit, 200),
        "mailto": settings.openalex_mailto or None,
    }
    works: list[dict] = []
    cursor = "*"

    with httpx.Client(timeout=30.0) as client:
        while len(works) < limit:
            page_params = {**params, "cursor": cursor}
            data = _get(client, page_params)
            page_results = data.get("results", [])
            if not page_results:
                break
            works.extend(page_results)
            cursor = data.get("meta", {}).get("next_cursor")
            if not cursor:
                break

    return works[:limit]


def _extract_doi(work: dict) -> str | None:
    doi = work.get("doi")
    if doi and doi.startswith("https://doi.org/"):
        return doi.removeprefix("https://doi.org/")
    return doi


def normalize_work(work: dict) -> NormalizedPaper:
    authorships: list[NormalizedAuthorship] = []
    for a in work.get("authorships", []):
        author_info = a.get("author", {})
        institutions = [
            NormalizedInstitution(
                name=inst.get("display_name", ""),
                source_name=SOURCE_NAME,
                source_institution_id=inst.get("id"),
                country=inst.get("country_code"),
                ror_id=inst.get("ror"),
            )
            for inst in a.get("institutions", [])
            if inst.get("display_name")
        ]
        authorships.append(
            NormalizedAuthorship(
                author=NormalizedAuthor(
                    full_name=author_info.get("display_name", "Unknown"),
                    source_name=SOURCE_NAME,
                    source_author_id=author_info.get("id", ""),
                    orcid=author_info.get("orcid"),
                ),
                institutions=institutions,
                position=None,  # OpenAlex conveys this via author_position string, mapped in loader
            )
        )

    primary_location = work.get("primary_location") or {}
    source_info = primary_location.get("source") or {}
    venue = (
        NormalizedVenue(
            name=source_info.get("display_name", "Unknown venue"),
            venue_type=source_info.get("type"),
            publisher=source_info.get("host_organization_name"),
            issn=(source_info.get("issn") or [None])[0] if source_info.get("issn") else None,
        )
        if source_info.get("display_name")
        else None
    )

    keywords = [k.get("display_name") for k in work.get("keywords", []) if k.get("display_name")]

    # OpenAlex ships an "abstract_inverted_index" instead of plain text —
    # reconstruct it since MongoDB should store readable abstracts.
    abstract = _reconstruct_abstract(work.get("abstract_inverted_index"))

    return NormalizedPaper(
        title=work.get("title") or work.get("display_name") or "Untitled",
        source_name=SOURCE_NAME,
        source_paper_id=work.get("id", ""),
        publication_year=work.get("publication_year") or 0,
        doi=_extract_doi(work),
        venue=venue,
        authorships=authorships,
        citation_count=work.get("cited_by_count"),
        cited_source_paper_ids=work.get("referenced_works", []) or [],
        abstract=abstract,
        keywords=keywords,
        embedding=None,   # OpenAlex does not ship embeddings
        raw_response=work,
    )


def _reconstruct_abstract(inverted_index: dict | None) -> str | None:
    if not inverted_index:
        return None
    position_to_word: dict[int, str] = {}
    for word, positions in inverted_index.items():
        for pos in positions:
            position_to_word[pos] = word
    if not position_to_word:
        return None
    return " ".join(position_to_word[i] for i in sorted(position_to_word))


def fetch_and_normalize(topic_query: str, limit: int = 200) -> list[NormalizedPaper]:
    return [normalize_work(w) for w in fetch_works_by_topic(topic_query, limit)]
