import { get, type Page, type Schemas } from "./client";

export type InstitutionSummary = Schemas["InstitutionSummary"];
export type InstitutionDetail = Schemas["InstitutionDetail"];
export type InstitutionSort = "papers" | "authors" | "name";

/** GET /institutions */
export const listInstitutions = (
  q: string | undefined,
  country: string | undefined,
  sort: InstitutionSort,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => get<Page<InstitutionSummary>>("/institutions", { q, country, sort, offset, limit }, signal);

/** GET /institutions/{id} */
export const institutionDetail = (id: number, signal?: AbortSignal) =>
  get<InstitutionDetail>(`/institutions/${id}`, {}, signal);

export type Collaborator = Schemas["Collaborator"];
export type InstitutionNetwork = Schemas["InstitutionNetwork"];
export type InstitutionNetworkNode = Schemas["InstitutionNetworkNode"];
export type InstitutionNetworkEdge = Schemas["InstitutionNetworkEdge"];

/** GET /institutions/{id}/collaborators */
export const institutionCollaborators = (id: number, offset: number, limit: number, signal?: AbortSignal) =>
  get<Page<Collaborator>>(`/institutions/${id}/collaborators`, { offset, limit }, signal);

/** GET /institutions/network (G5). The institution collaboration network in
 * one request: nodes capped at `limit` by weighted degree (truncated says
 * so), edges = COLLABORATION pairs with >= `minShared` shared papers. With
 * `centerId`, the ego network of that institution instead. */
export const institutionNetwork = (
  opts: { limit?: number; minShared?: number; centerId?: number },
  signal?: AbortSignal,
) =>
  get<InstitutionNetwork>(
    "/institutions/network",
    { limit: opts.limit, min_shared: opts.minShared, center_id: opts.centerId },
    signal,
  );

export type CountryBreakdown = Schemas["CountryBreakdownOut"];

/** GET /institutions/countries: institutions, papers and authors per country
 * (distinct counts, SQL-side), most papers first. */
export const institutionCountries = (limit: number, signal?: AbortSignal) =>
  get<CountryBreakdown>("/institutions/countries", { limit }, signal);
