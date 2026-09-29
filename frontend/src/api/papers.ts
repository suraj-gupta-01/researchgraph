import { get, type Page, type Schemas } from "./client";
import type { ChainNode } from "../lib/tree";

export type PaperSummary = Schemas["PaperSummary"];
export type PaperDetail = Schemas["PaperDetail"];
export type PaperListSort = "citations" | "year" | "title" | "relevance";
export type CitationDirection = "cites" | "cited_by";
export type CitationSort = "citations" | "year" | "title";

export interface PapersDirectoryFilters {
  q?: string; // title search (websearch syntax: quotes, OR, -exclude)
  yearFrom?: number;
  yearTo?: number;
  venueId?: number;
  authorId?: number;
  institutionId?: number;
  topicId?: number; // includes the topic's descendants
}

/** GET /papers — every filter the papers directory exposes. */
export const listPapers = (
  f: PapersDirectoryFilters,
  sort: PaperListSort,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) =>
  get<Page<PaperSummary>>(
    "/papers",
    {
      q: f.q,
      sort,
      year_from: f.yearFrom,
      year_to: f.yearTo,
      venue_id: f.venueId,
      author_id: f.authorId,
      institution_id: f.institutionId,
      topic_id: f.topicId,
      offset,
      limit,
    },
    signal,
  );

/** GET /papers/{id} */
export const paperDetail = (id: number, signal?: AbortSignal) => get<PaperDetail>(`/papers/${id}`, {}, signal);

/** GET /papers/{id}/citations */
export const paperCitations = (
  id: number,
  direction: CitationDirection,
  sort: CitationSort,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => get<Page<PaperSummary>>(`/papers/${id}/citations`, { direction, sort, offset, limit }, signal);

/** GET /papers/{id}/citation-chain */
export const citationChain = (id: number, direction: CitationDirection, depth: number, signal?: AbortSignal) =>
  get<ChainNode[]>(`/papers/${id}/citation-chain`, { direction, depth }, signal);
