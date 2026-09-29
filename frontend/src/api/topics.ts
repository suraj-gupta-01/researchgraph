import { get, type Page, type Schemas } from "./client";

export type TopicSummary = Schemas["TopicSummary"];
export type TopicDetail = Schemas["TopicDetail"];
export type TopicTrend = Schemas["TopicTrend"];
export type TrendingTopic = Schemas["TrendingTopic"];
export type ConvergingTopicPair = Schemas["ConvergingTopicPair"];
export type TopicPairTrend = Schemas["TopicPairTrend"];
export type TopicPairTrendPoint = Schemas["TopicPairTrendPoint"];
export type TrendDirection = "emerging" | "declining";

/** GET /topics */
export const listTopics = (
  q: string | undefined,
  parentId: number | undefined,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => get<Page<TopicSummary>>("/topics", { q, parent_id: parentId, offset, limit }, signal);

/** GET /topics/{id} */
export const topicDetail = (id: number, signal?: AbortSignal) => get<TopicDetail>(`/topics/${id}`, {}, signal);

/** GET /topics/{id}/trend — surfaced starting Phase 3 (topic-over-time figure). */
export const topicTrend = (id: number, signal?: AbortSignal) => get<TopicTrend>(`/topics/${id}/trend`, {}, signal);

/** GET /topics/trending — surfaced starting Phase 3 (emerging/declining board). */
export const trendingTopics = (
  direction: TrendDirection,
  year: number | undefined,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => get<Page<TrendingTopic>>("/topics/trending", { direction, year, offset, limit }, signal);

/** GET /topics/converging — surfaced starting Phase 6 (interdisciplinary connections). */
export const convergingTopics = (year: number | undefined, offset: number, limit: number, signal?: AbortSignal) =>
  get<Page<ConvergingTopicPair>>("/topics/converging", { year, offset, limit }, signal);

/** GET /topics/pairs/{a}/{b}/trend — surfaced starting Phase 6b (the
 * Connections board's pair drawer). Either id order resolves to the same
 * pair; the backend canonicalizes it. */
export const topicPairTrend = (topicAId: number, topicBId: number, signal?: AbortSignal) =>
  get<TopicPairTrend>(`/topics/pairs/${topicAId}/${topicBId}/trend`, {}, signal);
