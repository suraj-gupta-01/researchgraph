import { get, type Page, type Schemas } from "./client";

export type VenueSummary = Schemas["VenueSummary"];
export type VenueDetail = Schemas["VenueDetail"];
export type VenueSort = "papers" | "name";

/** GET /venues */
export const listVenues = (
  q: string | undefined,
  venueType: string | undefined,
  sort: VenueSort,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => get<Page<VenueSummary>>("/venues", { q, venue_type: venueType, sort, offset, limit }, signal);

/** GET /venues/{id} */
export const venueDetail = (id: number, signal?: AbortSignal) => get<VenueDetail>(`/venues/${id}`, {}, signal);
