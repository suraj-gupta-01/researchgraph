import { get, type Page, type Schemas } from "./client";

export type QueryCatalogEntry = Schemas["QueryCatalogEntry"];
export type CrossCommunityCitation = Schemas["CrossCommunityCitation"];
export type InstitutionTopicCollaboration = Schemas["InstitutionTopicCollaboration"];
export type TopicAuthorRow = Schemas["TopicAuthorRow"];
export type TopicYearCount = Schemas["TopicYearCount"];

/** GET /queries/catalog (G6): each Section 9 query with the SQL it runs. */
export const queryCatalog = (signal?: AbortSignal) => get<QueryCatalogEntry[]>("/queries/catalog", {}, signal);

/** GET /queries/topic-authors */
export const topicAuthors = (topicId: number, yearFrom: number, yearTo: number, offset: number, limit: number, signal?: AbortSignal) =>
  get<Page<TopicAuthorRow>>("/queries/topic-authors", { topic_id: topicId, year_from: yearFrom, year_to: yearTo, offset, limit }, signal);

/** GET /queries/cross-community-citations */
export const crossCommunityCitations = (communityId: number | undefined, offset: number, limit: number, signal?: AbortSignal) =>
  get<Page<CrossCommunityCitation>>("/queries/cross-community-citations", { community_id: communityId, offset, limit }, signal);

/** GET /queries/institution-topic-collaboration */
export const institutionTopicCollaboration = (topicA: number, topicB: number, offset: number, limit: number, signal?: AbortSignal) =>
  get<Page<InstitutionTopicCollaboration>>("/queries/institution-topic-collaboration", { topic_a: topicA, topic_b: topicB, offset, limit }, signal);

/** GET /queries/topic-year-counts */
export const topicYearCounts = (topicId: number, signal?: AbortSignal) =>
  get<TopicYearCount[]>("/queries/topic-year-counts", { topic_id: topicId }, signal);
