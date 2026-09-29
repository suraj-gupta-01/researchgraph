"""
Semantic Scholar adapter (Section 6.2). Requires SEMANTIC_SCHOLAR_API_KEY
for a workable rate limit — the unauthenticated tier is the top ingestion
risk flagged in the PRD (Section 11), request a key early.

Semantic Scholar's value here is richer citation-context data and its own
SPECTER paper embeddings, which can shortcut the topic-extraction/NLP work
that would otherwise need to be computed from scratch in M3.
"""
from __future__ import annotations

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from app.config import settings
from ingestion.common_schema import (
    NormalizedAuthor,
    NormalizedAuthorship,
    NormalizedPaper,
    NormalizedVenue,
)

BASE_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
SOURCE_NAME = "semantic_scholar"

FIELDS = ",".join(
    [
        "title",
        "abstract",
        "year",
        "externalIds",
        "venue",
        "publicationVenue",
        "citationCount",
        "authors",
        "authors.affiliations",
        "authors.externalIds",
        "embedding.specter_v2",
        "references.paperId",
        "references.externalIds",
        "fieldsOfStudy",
    ]
)


def _headers() -> dict:
    return {"x-api-key": settings.semantic_scholar_api_key} if settings.semantic_scholar_api_key else {}


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=20))
def _get(client: httpx.Client, params: dict) -> dict:
    resp = client.get(BASE_URL, params=params, headers=_headers())
    resp.raise_for_status()
    return resp.json()


def fetch_papers_by_topic(topic_query: str, limit: int = 200) -> list[dict]:
    params = {"query": topic_query, "fields": FIELDS, "limit": min(limit, 100)}
    papers: list[dict] = []
    offset = 0

    with httpx.Client(timeout=30.0) as client:
        while len(papers) < limit:
            page_params = {**params, "offset": offset}
            data = _get(client, page_params)
            page_results = data.get("data", [])
            if not page_results:
                break
            papers.extend(page_results)
            offset += len(page_results)
            if offset >= data.get("total", 0):
                break

    return papers[:limit]


def normalize_paper(paper: dict) -> NormalizedPaper:
    external_ids = paper.get("externalIds") or {}
    doi = external_ids.get("DOI")

    authorships: list[NormalizedAuthorship] = []
    for a in paper.get("authors", []):
        author_ext = a.get("externalIds") or {}
        authorships.append(
            NormalizedAuthorship(
                author=NormalizedAuthor(
                    full_name=a.get("name", "Unknown"),
                    source_name=SOURCE_NAME,
                    source_author_id=str(a.get("authorId", "")),
                    orcid=author_ext.get("ORCID"),
                ),
                institutions=[],  # Semantic Scholar's affiliations are free-text, not resolvable
                                  # to a clean institution record — left for OpenAlex to supply.
                position=None,
            )
        )

    venue_info = paper.get("publicationVenue") or {}
    venue = (
        NormalizedVenue(
            name=venue_info.get("name") or paper.get("venue") or "Unknown venue",
            venue_type=venue_info.get("type"),
            issn=venue_info.get("issn"),
        )
        if (venue_info.get("name") or paper.get("venue"))
        else None
    )

    embedding = None
    embedding_block = paper.get("embedding")
    if embedding_block and isinstance(embedding_block, dict):
        embedding = embedding_block.get("vector")

    # NOTE: in the Semantic Scholar API `citations` = papers that cite THIS
    # paper (incoming) and `references` = papers THIS paper cites (outgoing).
    # CITATION rows are (citing -> cited), so outgoing edges come from
    # `references`. Both the S2 paperId and the DOI are kept so the loader can
    # resolve a reference that was ingested from either source.
    cited_ids: list[str] = []
    for ref in paper.get("references") or []:
        if ref.get("paperId"):
            cited_ids.append(str(ref["paperId"]))
        ref_doi = (ref.get("externalIds") or {}).get("DOI")
        if ref_doi:
            cited_ids.append(ref_doi)

    return NormalizedPaper(
        title=paper.get("title") or "Untitled",
        source_name=SOURCE_NAME,
        source_paper_id=str(paper.get("paperId", "")),
        publication_year=paper.get("year") or 0,
        doi=doi,
        venue=venue,
        authorships=authorships,
        citation_count=paper.get("citationCount"),
        cited_source_paper_ids=cited_ids,
        abstract=paper.get("abstract"),
        keywords=paper.get("fieldsOfStudy") or [],
        embedding=embedding,
        raw_response=paper,
    )


def fetch_and_normalize(topic_query: str, limit: int = 200) -> list[NormalizedPaper]:
    return [normalize_paper(p) for p in fetch_papers_by_topic(topic_query, limit)]
