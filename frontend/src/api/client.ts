import type { components } from "./schema.d.ts";

export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

/** The API's uniform pagination envelope. The generated schema emits one
 * name per instantiation (Page_PaperSummary_, Page_AuthorSummary_, …); this
 * local alias is easier to read and has the identical shape. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type Schemas = components["schemas"];

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "http",
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/** Fired on any 401 from a data endpoint, so the auth layer (app/AuthContext)
 * can drop to the sign-in screen with a "session expired" message instead of
 * every page rendering its own error. */
export const UNAUTHORIZED_EVENT = "rg:unauthorized";

/** Same value the backend's CSRF guard requires on every POST (app/auth.py). */
const CSRF_HEADERS = { "X-Requested-With": "ResearchGraph" };

async function send<T>(url: URL, init: RequestInit, path: string): Promise<T> {
  let res: Response;
  try {
    // The session is an httpOnly cookie the page cannot read; "include"
    // sends it to the API origin (G7). No token ever touches storage.
    res = await fetch(url, { ...init, credentials: "include" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(`Cannot reach the API at ${API_URL}`, "network");
  }
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      /* body wasn't JSON; leave detail undefined */
    }
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(`API returned ${res.status} for ${path}`, "http", res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** One typed GET. Components never build URLs themselves — every endpoint
 * gets a small named function in a per-router module that calls this. */
export async function get<T>(path: string, params: QueryParams = {}, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, API_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return send<T>(url, { signal }, path);
}

/** One typed JSON POST, with the CSRF header. Only /auth/login and
 * /auth/logout use it; the data API is read-only. */
export async function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return send<T>(
    new URL(path, API_URL),
    {
      method: "POST",
      signal,
      headers: { ...CSRF_HEADERS, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    path,
  );
}
