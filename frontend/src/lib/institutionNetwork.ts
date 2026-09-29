/**
 * Pure helpers for the institution collaboration network (Phase 7, G5).
 * The shared graph engine (lib/graph.ts) keys categories by number; an
 * institution's category is its country, a string (or null when unknown),
 * so this maps countries onto stable numeric keys and back.
 */
import type { InstitutionNetworkEdge, InstitutionNetworkNode } from "../api/institutions";

export interface CountryKeys {
  keyOf: (country: string | null) => number | null;
  labelOf: (key: number) => string;
}

/** Alphabetical so the same set of countries always maps to the same keys,
 * whatever order the nodes arrive in. Null/blank country -> null key (the
 * legend's grey "Unknown country" bucket). */
export function countryKeys(nodes: Pick<InstitutionNetworkNode, "country">[]): CountryKeys {
  const countries = [...new Set(nodes.map((n) => n.country?.trim()).filter((c): c is string => !!c))].sort();
  const index = new Map(countries.map((c, i) => [c, i]));
  return {
    keyOf: (country) => {
      const c = country?.trim();
      return c ? (index.get(c) ?? null) : null;
    },
    labelOf: (key) => countries[key] ?? "Unknown country",
  };
}

/** Shared papers between the ego-network centre and one partner, read from
 * the drawn edges; 0 when they are not directly linked. */
export function sharedWithCentre(edges: InstitutionNetworkEdge[], centreId: number, otherId: number): number {
  const [a, b] = centreId < otherId ? [centreId, otherId] : [otherId, centreId];
  return edges.find((e) => e.source === a && e.target === b)?.shared_papers ?? 0;
}

/** Matrix row order: the ego network's own institution first (when there
 * is one), then by total shared papers, most collaborative first, so the
 * strongest partnerships gather in the top-left corner. Ties by name, then
 * id, so the order never depends on the order the API returned rows in. */
export function matrixOrder<T extends Pick<InstitutionNetworkNode, "institution_id" | "name" | "shared_papers">>(nodes: T[], centreId: number | null): T[] {
  return [...nodes].sort(
    (a, b) =>
      Number(b.institution_id === centreId) - Number(a.institution_id === centreId) ||
      b.shared_papers - a.shared_papers ||
      a.name.localeCompare(b.name) ||
      a.institution_id - b.institution_id,
  );
}
