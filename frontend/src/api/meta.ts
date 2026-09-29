import { get, type Schemas } from "./client";

export interface Health {
  postgres: string;
  mongo: string;
}

/** GET /health. Raises ApiError (kind "http", status 503) when a store is
 * down — the backend reports 503 with the same {postgres, mongo} body, so
 * callers should catch and read `error.detail` rather than treat it as a
 * generic failure. */
export const health = (signal?: AbortSignal) => get<Health>("/health", {}, signal);


export type MetaRuns = Schemas["MetaRuns"];
export type AnalysisRun = Schemas["AnalysisRun"];
export type ProvenanceCheck = Schemas["ProvenanceCheck"];

/** GET /meta/runs (G4): last run of each analysis (algorithm, date,
 * params, counts, status) plus the provenance validation checks. */
export const metaRuns = (signal?: AbortSignal) => get<MetaRuns>("/meta/runs", {}, signal);
