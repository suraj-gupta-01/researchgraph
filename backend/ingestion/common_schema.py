"""
Common intermediate schema (Section 6.2 of the PRD).

Both OpenAlex and Semantic Scholar adapters normalize their API responses
into these dataclasses before anything touches Postgres or MongoDB. This is
the seam where cross-source field differences get absorbed, so downstream
code (entity resolution, loader) never has to know which source a record
came from.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_DOI_PREFIXES = ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:")


def normalize_doi(doi: str | None) -> str | None:
    """DOIs are case-insensitive. Both sources are normalized to the same
    lowercase, prefix-free form so DOI equality (the primary merge key) is
    reliable across sources."""
    if not doi:
        return None
    d = doi.strip().lower()
    for prefix in _DOI_PREFIXES:
        if d.startswith(prefix):
            d = d[len(prefix):]
    return d or None


_ORCID = re.compile(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", re.IGNORECASE)


def normalize_orcid(orcid: str | None) -> str | None:
    """OpenAlex returns ORCIDs as URLs (https://orcid.org/0000-...), Semantic
    Scholar as the bare 16-digit form. Store the bare form so it fits the
    column and matches across sources."""
    if not orcid:
        return None
    m = _ORCID.search(orcid)
    return m.group(0).upper() if m else None


@dataclass
class NormalizedAuthor:
    full_name: str
    source_name: str                 # 'openalex' | 'semantic_scholar'
    source_author_id: str
    orcid: str | None = None

    def __post_init__(self) -> None:
        self.orcid = normalize_orcid(self.orcid)


@dataclass
class NormalizedInstitution:
    name: str
    source_name: str
    source_institution_id: str | None = None
    country: str | None = None
    ror_id: str | None = None        # OpenAlex-native; best merge key when present


@dataclass
class NormalizedAuthorship:
    author: NormalizedAuthor
    institutions: list[NormalizedInstitution] = field(default_factory=list)
    position: int | None = None


@dataclass
class NormalizedVenue:
    name: str
    venue_type: str | None = None
    publisher: str | None = None
    issn: str | None = None


@dataclass
class NormalizedPaper:
    title: str
    source_name: str                 # 'openalex' | 'semantic_scholar'
    source_paper_id: str
    publication_year: int
    doi: str | None = None
    venue: NormalizedVenue | None = None
    authorships: list[NormalizedAuthorship] = field(default_factory=list)
    citation_count: int | None = None
    cited_source_paper_ids: list[str] = field(default_factory=list)  # outgoing citations, same-source IDs
    abstract: str | None = None
    keywords: list[str] = field(default_factory=list)
    embedding: list[float] | None = None    # populated when the source ships one (e.g. SPECTER)
    raw_response: dict | None = None        # kept for MongoDB, full fidelity / debugging

    def __post_init__(self) -> None:
        self.doi = normalize_doi(self.doi)
