import { get, type Page, type Schemas } from "./client";

export type AuthorSummary = Schemas["AuthorSummary"];
export type AuthorDetail = Schemas["AuthorDetail"];
export type AuthorSort = "papers" | "citations" | "name";
export type AuthorInfluence = Schemas["AuthorInfluence"];
export type AuthorCommunityTie = Schemas["AuthorCommunityTie"];
export type BridgeAuthor = Schemas["BridgeAuthor"];
export type BridgePage = Schemas["BridgePage"];

/** GET /authors */
export const listAuthors = (
  q: string | undefined,
  institutionId: number | undefined,
  sort: AuthorSort,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => get<Page<AuthorSummary>>("/authors", { q, institution_id: institutionId, sort, offset, limit }, signal);

/** GET /authors/{id} */
export const authorDetail = (id: number, signal?: AbortSignal) => get<AuthorDetail>(`/authors/${id}`, {}, signal);

/** GET /authors/{id}/influence -- the F4 profile: degree/betweenness/PageRank,
 * bridge score (participation coefficient), and per-community ties. Two
 * distinct 404s: author not found vs. author exists but graph.influence
 * hasn't scored them yet -- see lib/influence.ts#isUnscored. */
export const authorInfluence = (id: number, signal?: AbortSignal) => get<AuthorInfluence>(`/authors/${id}/influence`, {}, signal);

/** GET /authors/bridges -- the F4 board (Phase 5b). Without `q`, every author
 * touching `min_communities` or more of the currently detected communities,
 * ranked by bridge_score then PageRank. With `q`, scoped to the topic's own
 * matched communities and re-ranked by `matched_communities` first -- see
 * `references/api-coverage.md` §2 and backend/app/routers/authors.py. */
export const listBridgeAuthors = (q: string | undefined, minCommunities: number, offset: number, limit: number, signal?: AbortSignal) =>
  get<BridgePage>("/authors/bridges", { q, min_communities: minCommunities, offset, limit }, signal);
