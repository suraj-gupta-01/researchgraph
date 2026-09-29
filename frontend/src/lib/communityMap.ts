/**
 * Community-level summary of the author collaboration graph: the overview
 * the /communities/graph page leads with. A 48-author graph is 2,304
 * matrix cells, but what it says fits in a handful of numbers: how tightly
 * each community's members are tied to each other, and how strongly each
 * pair of communities is linked. Everything here is derived from the same
 * /communities/graph response the page already loads.
 *
 * "Tie strength" is averaged per member pair (sum of edge weights divided
 * by the number of possible pairs), so a large community is not made to
 * look tighter just by having more members.
 */
import type { CommunityGraphEdge, CommunityGraphNode } from "../api/communities";

export interface MapCommunity {
  id: number;
  size: number;
  /** Average tie strength between two members of this community (0 for a
   * one-member community, which has no internal pairs). */
  within: number;
}

export interface MapLink {
  a: number;
  b: number;
  /** Average tie strength between a member of `a` and a member of `b`. */
  avg: number;
}

export interface CommunitySummary {
  communities: MapCommunity[];
  links: MapLink[];
  /** Researchers Louvain left out of every community (not on the map). */
  unassigned: number;
}

const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function summarizeCommunities(nodes: CommunityGraphNode[], edges: CommunityGraphEdge[]): CommunitySummary {
  const communityOf = new Map<number, number>();
  const size = new Map<number, number>();
  let unassigned = 0;
  for (const n of nodes) {
    if (n.community_id === null) {
      unassigned++;
      continue;
    }
    communityOf.set(n.author_id, n.community_id);
    size.set(n.community_id, (size.get(n.community_id) ?? 0) + 1);
  }
  const total = new Map<string, number>();
  for (const e of edges) {
    const a = communityOf.get(e.source);
    const b = communityOf.get(e.target);
    if (a === undefined || b === undefined) continue;
    total.set(key(a, b), (total.get(key(a, b)) ?? 0) + e.weight);
  }
  const ids = [...size.keys()].sort((x, y) => (size.get(y)! - size.get(x)!) || x - y);
  const communities = ids.map((id) => {
    const n = size.get(id)!;
    const pairs = (n * (n - 1)) / 2;
    return { id, size: n, within: pairs > 0 ? (total.get(key(id, id)) ?? 0) / pairs : 0 };
  });
  const links: MapLink[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const t = total.get(key(ids[i], ids[j])) ?? 0;
      if (t > 0) links.push({ a: ids[i], b: ids[j], avg: t / (size.get(ids[i])! * size.get(ids[j])!) });
    }
  }
  links.sort((x, y) => y.avg - x.avg);
  return { communities, links, unassigned };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** The one or two sentences above the map. Only states what the numbers
 * support: the inside/outside ratio when there are at least two
 * communities, and a loosest community only when it stands out (under
 * three quarters of the typical community's internal strength). */
export function takeaway(s: CommunitySummary, labelOf: (id: number) => string): string[] {
  const out: string[] = [];
  const inside = s.communities.filter((c) => c.size > 1).map((c) => c.within);
  const between = s.links.map((l) => l.avg);
  if (inside.length > 0 && between.length > 0 && mean(between) > 0) {
    const ratio = mean(inside) / mean(between);
    out.push(
      ratio >= 1.2
        ? `Researchers are about ${ratio.toFixed(1)}× more strongly tied inside their own community than to other communities.`
        : "Ties inside communities are about as strong as ties between them, so these communities are only loosely separated.",
    );
  }
  const withInside = s.communities.filter((c) => c.size > 1);
  if (withInside.length >= 3) {
    const sorted = [...withInside].sort((a, b) => a.within - b.within);
    const median = sorted[Math.floor(sorted.length / 2)].within;
    if (sorted[0].within < 0.75 * median) out.push(`${labelOf(sorted[0].id)} is the most loosely knit community.`);
  }
  return out;
}

/** A community's members, most tied-in first: each member's total tie
 * strength to the rest of their own community. */
export function membersByCohesion(communityId: number, nodes: CommunityGraphNode[], edges: CommunityGraphEdge[]): { node: CommunityGraphNode; inside: number }[] {
  const members = nodes.filter((n) => n.community_id === communityId);
  const ids = new Set(members.map((n) => n.author_id));
  const inside = new Map<number, number>();
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) {
      inside.set(e.source, (inside.get(e.source) ?? 0) + e.weight);
      inside.set(e.target, (inside.get(e.target) ?? 0) + e.weight);
    }
  }
  return members
    .map((node) => ({ node, inside: inside.get(node.author_id) ?? 0 }))
    .sort((a, b) => b.inside - a.inside || a.node.full_name.localeCompare(b.node.full_name));
}
