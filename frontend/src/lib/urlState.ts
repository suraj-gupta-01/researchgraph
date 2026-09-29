/**
 * Typed helpers for reading and writing query-string state. Routes use
 * react-router's `useSearchParams` for the get/set mechanics; these
 * functions are the one place that knows how to parse and serialize each
 * value shape, so every page encodes state (scope, filters, sort, page,
 * year, selected entity) into the URL the same way.
 */

export interface EntityRef {
  id: number;
  name: string;
}

export function getNum(params: URLSearchParams, key: string): number | undefined {
  const v = params.get(key);
  if (v === null || !/^-?\d+$/.test(v)) return undefined;
  return Number(v);
}

export function getStr(params: URLSearchParams, key: string): string | undefined {
  const v = params.get(key);
  return v === null || v === "" ? undefined : v;
}

/** An id + display-name pair stored as two params, e.g. `author=12&authorName=A.+Lee`. */
export function getRef(params: URLSearchParams, idKey: string, nameKey: string): EntityRef | undefined {
  const id = getNum(params, idKey);
  if (id === undefined) return undefined;
  return { id, name: params.get(nameKey) ?? `#${id}` };
}

export function setNum(params: URLSearchParams, key: string, v: number | undefined) {
  if (v === undefined || Number.isNaN(v)) params.delete(key);
  else params.set(key, String(v));
}

export function setStr(params: URLSearchParams, key: string, v: string | undefined, omitIf?: string) {
  if (!v || v === omitIf) params.delete(key);
  else params.set(key, v);
}

export function setRef(params: URLSearchParams, idKey: string, nameKey: string, v: EntityRef | undefined) {
  if (v === undefined) {
    params.delete(idKey);
    params.delete(nameKey);
  } else {
    params.set(idKey, String(v.id));
    params.set(nameKey, v.name);
  }
}

/** Page-size aware offset/limit pair shared by every directory and list view. */
export interface PageState {
  offset: number;
  limit: number;
}

export function getPage(params: URLSearchParams, defaultLimit = 20): PageState {
  return { offset: getNum(params, "offset") ?? 0, limit: getNum(params, "limit") ?? defaultLimit };
}

export function setPage(params: URLSearchParams, page: PageState, defaultLimit = 20) {
  setNum(params, "offset", page.offset || undefined);
  setNum(params, "limit", page.limit === defaultLimit ? undefined : page.limit);
}
