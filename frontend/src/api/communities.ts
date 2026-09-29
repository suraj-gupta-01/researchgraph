import { get, type Page, type Schemas } from "./client";

export type CommunitySummary = Schemas["CommunitySummary"];
export type CommunityDetail = Schemas["CommunityDetail"];
export type CommunityMemberOut = Schemas["CommunityMemberOut"];
export type CommunityPage = Schemas["CommunityPage"];
export type CommunityGraph = Schemas["CommunityGraph"];
export type CommunityGraphNode = Schemas["CommunityGraphNode"];
export type CommunityGraphEdge = Schemas["CommunityGraphEdge"];

/** GET /communities */
export const listCommunities = (
  q: string | undefined,
  topMembers: number,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => get<CommunityPage>("/communities", { q, top_members: topMembers, offset, limit }, signal);

/** GET /communities/{id} */
export const communityDetail = (id: number, topMembers: number, signal?: AbortSignal) =>
  get<CommunityDetail>(`/communities/${id}`, { top_members: topMembers }, signal);

/** GET /communities/{id}/members */
export const communityMembers = (id: number, offset: number, limit: number, signal?: AbortSignal) =>
  get<Page<CommunityMemberOut>>(`/communities/${id}/members`, { offset, limit }, signal);

/** GET /communities/graph (G1). `q` scopes to authors of matching papers;
 * `minWeight` drops edges below that combined weight; `maxNodes` caps the
 * node count, kept by weighted degree (see CommunityGraph.truncated). */
export const communityGraph = (
  q: string | undefined,
  minWeight: number,
  maxNodes: number,
  signal?: AbortSignal,
) => get<CommunityGraph>("/communities/graph", { q, min_weight: minWeight, max_nodes: maxNodes }, signal);
