/** Matches GET /papers/{id}/citation-chain's flat, cycle-safe response. */
export interface ChainNode {
  paper_id: number;
  title: string;
  publication_year: number;
  citation_count: number;
  depth: number;
  parent_paper_id: number;
}

export interface ChainTreeNode extends ChainNode {
  children: ChainTreeNode[];
}

/**
 * The backend already de-cycles (a `path` guard in the recursive CTE) and
 * keeps each paper at its shallowest depth (DISTINCT ON), so this only has
 * to group children by parent. A `visited` guard is kept anyway: client
 * code should never infinite-loop on data it did not validate itself.
 */
export function buildChainTree(nodes: ChainNode[], rootId: number): ChainTreeNode[] {
  const byParent = new Map<number, ChainNode[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parent_paper_id);
    if (list) list.push(n);
    else byParent.set(n.parent_paper_id, [n]);
  }
  const visited = new Set<number>();
  const build = (parentId: number): ChainTreeNode[] =>
    (byParent.get(parentId) ?? [])
      .filter((n) => !visited.has(n.paper_id))
      .map((n) => {
        visited.add(n.paper_id);
        return { ...n, children: build(n.paper_id) };
      });
  return build(rootId);
}

/** Deepest depth present, for a "chain truncated at depth n" note when the
 * tree is as deep as the requested max depth. */
export function maxDepth(nodes: ChainNode[]): number {
  return nodes.reduce((m, n) => Math.max(m, n.depth), 0);
}
