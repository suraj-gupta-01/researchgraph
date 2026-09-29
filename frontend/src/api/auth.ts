import { get, post, type Schemas } from "./client";

export type Session = Schemas["SessionOut"];
export type Account = Schemas["AccountOut"];
export type Role = "viewer" | "analyst" | "admin";

const RANK: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2 };

/** True when `role` includes everything `needed` may do. */
export const hasRole = (role: string, needed: Role) => (RANK[role as Role] ?? -1) >= RANK[needed];

/** POST /auth/login. Sets the httpOnly session cookie; 401 bad credentials,
 * 429 rate-limited (detail + Retry-After). */
export const login = (username: string, password: string) => post<Session>("/auth/login", { username, password });

/** POST /auth/logout */
export const logout = () => post<void>("/auth/logout");

/** GET /auth/me. 401 = not signed in. */
export const me = (signal?: AbortSignal) => get<Session>("/auth/me", {}, signal);

/** GET /auth/users (admin) */
export const listAccounts = (signal?: AbortSignal) => get<Account[]>("/auth/users", {}, signal);
