import { get, type Page, type Schemas } from "./client";
import type { EntityRef } from "../lib/urlState";

export type SearchOverview = Schemas["SearchOverview"];
export type PaperSummary = Schemas["PaperSummary"];
export type PaperSort = "relevance" | "citations" | "year" | "title";
export type CitationNetwork = Schemas["CitationNetwork"];
export type CitationNetworkNode = Schemas["CitationNetworkNode"];
export type CitationNetworkEdge = Schemas["CitationNetworkEdge"];

/** The filter shape /search/overview and /search/papers share, so the
 * facets and the result list are always driven by one state object
 * (api-coverage.md §3, "Filters are shared"). */
export interface SearchFilters {
  q: string;
  yearFrom?: number;
  yearTo?: number;
  author?: EntityRef;
  institution?: EntityRef;
  venue?: EntityRef;
}

const filterParams = (f: SearchFilters) => ({
  q: f.q,
  year_from: f.yearFrom,
  year_to: f.yearTo,
  author_id: f.author?.id,
  institution_id: f.institution?.id,
  venue_id: f.venue?.id,
});

/** GET /search/overview */
export const searchOverview = (f: SearchFilters, signal?: AbortSignal) =>
  get<SearchOverview>("/search/overview", filterParams(f), signal);

/** GET /search/papers */
export const searchPapers = (f: SearchFilters, sort: PaperSort, offset: number, limit: number, signal?: AbortSignal) =>
  get<Page<PaperSummary>>("/search/papers", { ...filterParams(f), sort, offset, limit }, signal);

/** GET /search/citation-network (G2). The directed citation graph of the
 * same result set `f` would list on /search/papers; `maxNodes` caps the
 * node count, kept by in-set citation degree (CitationNetwork.truncated). */
export const searchCitationNetwork = (f: SearchFilters, maxNodes: number, signal?: AbortSignal) =>
  get<CitationNetwork>("/search/citation-network", { ...filterParams(f), max_nodes: maxNodes }, signal);
