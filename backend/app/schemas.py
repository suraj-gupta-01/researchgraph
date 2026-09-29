"""Response models. They exist mainly so /docs shows real shapes."""
from __future__ import annotations

from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class PaperSummary(BaseModel):
    paper_id: int
    title: str
    doi: str | None
    publication_year: int
    citation_count: int
    venue_id: int | None
    venue_name: str | None
    authors: list[str]          # first few, in author order
    author_count: int
    relevance: float | None = None   # only on /search/papers


class InstitutionRef(BaseModel):
    institution_id: int
    name: str
    country: str | None


class PaperAuthor(BaseModel):
    author_id: int
    full_name: str
    orcid: str | None
    position: int | None
    institutions: list[InstitutionRef]


class PaperSource(BaseModel):
    source_name: str
    source_record_id: str
    source_citation_count: int | None
    fetched_at: datetime


class PaperTopic(BaseModel):
    topic_id: int
    topic_name: str
    relevance_score: float
    extraction_method: str | None


class VenueRef(BaseModel):
    venue_id: int
    venue_name: str
    venue_type: str | None
    publisher: str | None


class PaperDetail(BaseModel):
    paper_id: int
    title: str
    doi: str | None
    publication_year: int
    citation_count: int                 # reconciled across sources (see loader conflict rule)
    venue: VenueRef | None
    authors: list[PaperAuthor]
    sources: list[PaperSource]          # provenance: per-source ids and counts
    topics: list[PaperTopic]            # empty until M3 topic extraction runs
    cites_in_corpus: int                # outgoing edges to papers we hold
    cited_by_in_corpus: int             # incoming edges from papers we hold
    abstract: str | None
    keywords: list[str]
    text_status: str                    # ok | missing | unavailable (Mongo)


class ChainNode(BaseModel):
    paper_id: int
    title: str
    publication_year: int
    citation_count: int
    depth: int
    parent_paper_id: int


class AuthorSummary(BaseModel):
    author_id: int
    full_name: str
    orcid: str | None
    paper_count: int
    total_citations: int


class AuthorInstitution(BaseModel):
    institution_id: int
    name: str
    country: str | None
    first_year: int | None
    last_year: int | None


class Coauthor(BaseModel):
    author_id: int
    full_name: str
    shared_papers: int


class YearCount(BaseModel):
    year: int
    paper_count: int


class AuthorDetail(AuthorSummary):
    openalex_author_id: str | None
    semantic_scholar_author_id: str | None
    institutions: list[AuthorInstitution]
    coauthors: list[Coauthor]
    papers_by_year: list[YearCount]


class InstitutionSummary(BaseModel):
    institution_id: int
    name: str
    country: str | None
    ror_id: str | None
    paper_count: int
    author_count: int


class Collaborator(BaseModel):
    institution_id: int
    name: str
    country: str | None
    shared_papers: int


class CountryBreakdown(BaseModel):
    country: str | None        # None groups institutions with no recorded country
    institution_count: int
    paper_count: int           # distinct papers with >= 1 author attributed to an institution in the country
    author_count: int          # distinct authors ever affiliated with an institution in the country


class CountryBreakdownOut(BaseModel):
    items: list[CountryBreakdown]
    total_institutions: int
    total_papers: int          # distinct papers with any institution attribution (a paper spanning countries counts once)


# ---- G5 institution network (Phase 7 frontend gap) ------------------------

class InstitutionNetworkNode(BaseModel):
    institution_id: int
    name: str
    country: str | None
    paper_count: int           # all of the institution's papers, not only the collaborative ones
    collaborators: int         # distinct partners among the returned nodes (degree in this graph)
    shared_papers: int         # sum of edge weights among the returned nodes (weighted degree)


class InstitutionNetworkEdge(BaseModel):
    source: int                # institution_id, always the lower id (COLLABORATION's canonical order)
    target: int                # institution_id
    shared_papers: int         # distinct papers the pair co-appears on


class InstitutionNetwork(BaseModel):
    nodes: list[InstitutionNetworkNode]
    edges: list[InstitutionNetworkEdge]
    center_id: int | None      # set in ego mode: the institution the network is centred on
    min_shared: int
    total_candidates: int      # institutions with >= 1 qualifying edge before the limit cap
    truncated: bool            # true when total_candidates > len(nodes)


class InstitutionAuthor(BaseModel):
    author_id: int
    full_name: str
    paper_count: int


class InstitutionDetail(InstitutionSummary):
    top_authors: list[InstitutionAuthor]
    papers_by_year: list[YearCount]


class VenueSummary(BaseModel):
    venue_id: int
    venue_name: str
    venue_type: str | None
    publisher: str | None
    paper_count: int


class VenueDetail(VenueSummary):
    issn: str | None
    papers_by_year: list[YearCount]


class TopicSummary(BaseModel):
    topic_id: int
    topic_name: str
    parent_topic_id: int | None
    paper_count: int


class TopicDetail(TopicSummary):
    description: str | None
    parent: TopicSummary | None
    children: list[TopicSummary]


# ---- F3 emerging topics (M4 Part 2) --------------------------------------

class TopicSnapshotPoint(BaseModel):
    year: int
    paper_count: int
    author_count: int
    institution_count: int
    citation_count: int
    growth_rate: float | None           # None only if graph.trends hasn't run yet for this period
    trend_label: str | None             # Emerging | Stable | Declining | Converging (F5) | None if not classified
    score: float | None


class TopicTrend(BaseModel):
    topic_id: int
    topic_name: str
    algorithm: str | None               # None if graph.trends hasn't run yet
    points: list[TopicSnapshotPoint]    # one per year the topic has a TOPIC_SNAPSHOT row, oldest first


class TrendingTopic(BaseModel):
    topic_id: int
    topic_name: str
    year: int
    paper_count: int
    prior_year_paper_count: int         # 0 if the topic has no snapshot for year - 1
    growth_rate: float | None
    score: float | None
    trend_label: str


# ---- F5 topic convergence (M4 Part 4b) ------------------------------------

class ConvergingTopicPair(BaseModel):
    topic_a_id: int
    topic_a_name: str
    topic_b_id: int
    topic_b_name: str
    year: int
    cooccurrence_count: int
    prior_cooccurrence_count: int       # 0 if the pair has no TOPIC_PAIR_TREND row for year - 1
    growth_rate: float
    convergence_score: float


class TopicPairTrendPoint(BaseModel):
    year: int
    cooccurrence_count: int
    prior_cooccurrence_count: int
    growth_rate: float
    is_converging: bool


class TopicPairTrend(BaseModel):
    """G3 (api-coverage.md §4): a pair's full TOPIC_PAIR_TREND history,
    oldest year first, for the Phase 6b pair drawer's trajectory chart."""
    topic_a_id: int
    topic_a_name: str
    topic_b_id: int
    topic_b_name: str
    algorithm: str | None               # None if the pair has no TOPIC_PAIR_TREND rows
    points: list[TopicPairTrendPoint]


# ---- F1 search -----------------------------------------------------------

class AuthorFacet(BaseModel):
    author_id: int
    full_name: str
    paper_count: int
    total_citations: int


class InstitutionFacet(BaseModel):
    institution_id: int
    name: str
    country: str | None
    paper_count: int


class VenueFacet(BaseModel):
    venue_id: int
    venue_name: str
    paper_count: int


class TopicFacet(BaseModel):
    topic_id: int
    topic_name: str
    paper_count: int
    avg_relevance: float


class KeywordFacet(BaseModel):
    keyword: str
    paper_count: int


class SearchSummary(BaseModel):
    papers: int
    authors: int
    institutions: int
    citation_edges: int        # citations between papers inside the result set
    year_min: int | None
    year_max: int | None


class SearchMeta(BaseModel):
    mongo: str                 # ok | unavailable | skipped
    matched_via: dict[str, int]    # title / abstract / topic: candidate counts before filters
    truncated: bool            # a channel hit its candidate cap


class SearchOverview(BaseModel):
    query: str
    summary: SearchSummary
    year_histogram: list[YearCount]     # ignores the year filter so it can act as a brush
    top_authors: list[AuthorFacet]
    top_institutions: list[InstitutionFacet]
    top_venues: list[VenueFacet]
    topics: list[TopicFacet]            # from PAPER_TOPIC; empty until M3
    keywords: list[KeywordFacet]        # from Mongo keywords; works before M3
    meta: SearchMeta


# ---- G2 citation network (Phase 7 frontend gap) ---------------------------

class CitationNetworkNode(BaseModel):
    paper_id: int
    title: str
    year: int
    citation_count: int
    community_id: int | None    # majority community of the paper's authors; None if unassigned or graph.communities hasn't run


class CitationNetworkEdge(BaseModel):
    citing_id: int   # paper_id
    cited_id: int     # paper_id


class CitationNetwork(BaseModel):
    nodes: list[CitationNetworkNode]
    edges: list[CitationNetworkEdge]
    total_candidates: int      # result-set papers with >= 1 citation edge to another result-set paper, before max_nodes
    truncated: bool            # true when total_candidates > len(nodes)
    query: str
    search_meta: dict          # same shape as /search/overview's meta (mongo status, channels, truncated)


# ---- F2 communities (M4) -------------------------------------------------

class CommunityMemberOut(BaseModel):
    author_id: int
    full_name: str
    membership_score: float | None   # share of the author's tie weight that stays inside the community
    paper_count: int


class CommunitySummary(BaseModel):
    community_id: int
    label: str | None
    root_topic_id: int | None
    root_topic_name: str | None
    algorithm: str                   # includes the parameters, e.g. louvain(resolution=1,seed=42)
    detection_date: datetime
    member_count: int
    paper_count: int                 # distinct papers written by at least one member
    matched_papers: int | None = None    # only when searching (?q=): papers matching the query
    matched_members: int | None = None   # ... and how many members wrote them
    top_members: list[CommunityMemberOut]


class CommunityPage(Page[CommunitySummary]):
    query: str | None = None
    search_meta: dict | None = None      # same shape as /search/overview meta (mongo status, channels)


class CommunityInstitution(BaseModel):
    institution_id: int
    name: str
    country: str | None
    member_count: int


class CommunityTopic(BaseModel):
    topic_id: int
    topic_name: str
    share: float             # fraction of the community's papers tagged with the topic
    corpus_share: float      # fraction of all papers tagged with it
    score: float             # share * ln(1/corpus_share): why it earns a place in the label


class CommunityDetail(CommunitySummary):
    year_min: int | None
    year_max: int | None
    top_institutions: list[CommunityInstitution]
    topics: list[CommunityTopic]
    topics_status: str       # ok | stale (evidence is from another run) | missing (none stored) | unavailable (Mongo down)


# ---- G1 community graph (Phase 4 frontend gap) ----------------------------

class GraphEdgeSignals(BaseModel):
    """The four PRD F2 edge sources that contributed to an edge's weight; see
    graph/build_graph.py's WEIGHT_* constants. 0.0 means that signal
    contributed nothing to this particular pair, not that it is unknown."""
    coauthor: float
    citation: float
    topic: float
    institution: float


class CommunityGraphNode(BaseModel):
    author_id: int
    full_name: str
    community_id: int | None          # None if graph.communities hasn't run, or the author was left unassigned
    membership_score: float | None    # None for the same two reasons
    paper_count: int
    bridge_score: float | None        # None if graph.influence hasn't run yet
    communities_touched: int | None   # None for the same reason


class CommunityGraphEdge(BaseModel):
    source: int   # author_id
    target: int   # author_id
    weight: float
    signals: GraphEdgeSignals


class CommunityGraph(BaseModel):
    nodes: list[CommunityGraphNode]
    edges: list[CommunityGraphEdge]
    algorithm: str | None          # graph.communities' algorithm string; None if it hasn't run yet
    detection_date: datetime | None
    total_candidates: int          # authors with >= 1 qualifying edge before the max_nodes cap
    truncated: bool                # true when total_candidates > len(nodes)
    query: str | None = None
    search_meta: dict | None = None   # same shape as /communities' search_meta, only present with ?q=


# ---- F4 researcher influence & bridge detection (M4 Part 3) --------------

class AuthorCommunityTie(BaseModel):
    community_id: int
    label: str | None            # RESEARCH_COMMUNITY.Label at query time (None if the community was since replaced)
    weight: float                 # this author's total tie weight into the community's members
    share: float                  # weight / this author's total tie weight into ANY community


class AuthorInfluence(BaseModel):
    author_id: int
    full_name: str
    degree_centrality: float
    betweenness_centrality: float
    pagerank: float
    bridge_score: float          # participation coefficient (0..1); see graph/influence_core.py
    communities_touched: int     # PRD's own bar for "bridge researcher" is >= 2
    algorithm: str
    detection_date: datetime
    ties: list[AuthorCommunityTie]   # the evidence behind bridge_score, largest tie first


class BridgeAuthor(BaseModel):
    author_id: int
    full_name: str
    paper_count: int
    degree_centrality: float
    betweenness_centrality: float
    pagerank: float
    bridge_score: float
    communities_touched: int          # overall, across every detected community
    matched_communities: int | None = None   # only when searching (?q=): communities touched among the query's matches
    ties: list[AuthorCommunityTie]


class BridgePage(Page[BridgeAuthor]):
    query: str | None = None
    search_meta: dict | None = None      # same shape as /communities' search_meta
    algorithm: str | None = None         # None if graph.influence hasn't run yet


# ---- G4 runs and methods (Phase 8 frontend gap) ----------------------------

class AnalysisRun(BaseModel):
    analysis: str                  # graph | communities | trends | convergence | influence | provenance
    status: str                    # ok | not_run | postgres_only | mismatch (see /meta/runs)
    source: str | None             # mongo | postgres | None when not run
    algorithm: str | None          # with parameters, e.g. louvain(resolution=1,seed=42); None for graph/provenance
    detected_at: datetime | None
    params: dict
    counts: dict                   # headline scalars from the run summary
    details: dict                  # nested summary objects (graph sizes, label counts, stats, ...)
    postgres_rows: int | None      # result rows stamped by the run; None when the analysis has no Postgres table


class ProvenanceCheck(BaseModel):
    name: str
    status: str                    # pass | fail | warn | skipped -- skipped is not a pass
    detail: str | None
    count: int | None


class MetaRuns(BaseModel):
    mongo: str                     # ok | unavailable
    runs: list[AnalysisRun]
    provenance_checks: list[ProvenanceCheck]


# ---- G6 Section 9 demo queries (Phase 9 query lab) -------------------------

class QueryObject(BaseModel):
    kind: str                      # view | function
    name: str
    definition: str                # live from pg_get_viewdef / pg_get_functiondef


class QueryCatalogEntry(BaseModel):
    key: str
    title: str
    prd_text: str                  # the PRD Section 9 sentence this answers
    kind: str
    endpoint: str
    statement: str                 # the exact SQL the endpoint executes (bound parameters as :name)
    objects: list[QueryObject]


class CrossCommunityCitation(BaseModel):
    citing_paper_id: int
    citing_title: str
    citing_year: int
    citing_community_id: int
    citing_community_label: str | None
    cited_paper_id: int
    cited_title: str
    cited_year: int
    cited_community_id: int
    cited_community_label: str | None


class InstitutionTopicCollaboration(BaseModel):
    institution_a_id: int
    institution_a_name: str
    institution_a_country: str | None
    institution_b_id: int
    institution_b_name: str
    institution_b_country: str | None
    shared_papers: int             # papers co-authored by the pair AND tagged with both topics
    example_paper_ids: list[int]   # up to 5, lowest ids first


class TopicAuthorRow(BaseModel):
    author_id: int
    full_name: str
    paper_count: int
    first_year: int
    last_year: int
    institutions: list[str]        # empty when no per-paper affiliation is recorded (Semantic Scholar-only papers)


class TopicYearCount(BaseModel):
    year: int
    paper_count: int
    citation_count: int


# ---- G7 authentication ------------------------------------------------------

class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class SessionOut(BaseModel):
    auth_enabled: bool             # false: AUTH_ENABLED=false, everyone is an anonymous admin
    username: str
    role: str                      # viewer | analyst | admin
    expires_at: datetime | None


class AccountOut(BaseModel):
    username: str
    role: str
