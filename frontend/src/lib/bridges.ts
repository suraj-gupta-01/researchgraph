/**
 * Pure helpers for the Bridge researchers board (Phase 5b, F4). Kept
 * separate from the fetching component (features/bridges/BridgesBoard.tsx)
 * so the labeling and axis-scale decisions are unit-tested without a DOM.
 * Contract source: references/phases.md Phase 5, references/api-coverage.md
 * §2-3, references/design-system.md §5.
 */
import type { CommunityKey } from "../charts/TieProfileChart";
import { COMMUNITY_NONE_COLOR, COMMUNITY_PALETTE, MAX_COLORED_COMMUNITIES } from "./graph";

/** Community colours for the tie-profile chart, by the same rule every
 * community legend uses (lib/graph.ts#buildCategoricalLegend): largest
 * community first, ties by id, the first eight get the palette, the rest
 * share the "other" grey. So a community is the same colour here as on the
 * Communities pages. */
export function communityKeys(list: { community_id: number; label: string | null; member_count: number }[]): CommunityKey[] {
  return [...list]
    .sort((a, b) => b.member_count - a.member_count || a.community_id - b.community_id)
    .map((c, i) => ({
      id: c.community_id,
      label: c.label ?? `Community ${c.community_id}`,
      color: i < MAX_COLORED_COMMUNITIES ? COMMUNITY_PALETTE[i] : COMMUNITY_NONE_COLOR,
    }));
}

/** `min_communities` is the board's own request parameter (api-coverage.md
 * §2: "1-20, default 2"); keep the one shared default and range check here
 * so the URL param, the control and the request all agree. */
export const MIN_COMMUNITIES_DEFAULT = 2;
export const MIN_COMMUNITIES_RANGE = { min: 1, max: 20 } as const;

export function isValidMinCommunities(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_COMMUNITIES_RANGE.min && n <= MIN_COMMUNITIES_RANGE.max;
}

/** The board's own empty-state split. `algorithm` comes from AUTHOR_INFLUENCE
 * and is populated the moment `graph.influence` has run at all -- before
 * `min_communities` or `q` narrow anything -- so its presence on an
 * otherwise-empty page distinguishes "nothing meets this filter" from
 * "the analysis has not run yet" without a second request (unlike the
 * Trends and Communities boards, which must ask the server a second,
 * unfiltered question to tell the two apart). */
export function isNotComputed(total: number, algorithm: string | null | undefined): boolean {
  return total === 0 && !algorithm;
}
