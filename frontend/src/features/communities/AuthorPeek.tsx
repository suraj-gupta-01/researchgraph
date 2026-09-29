import { Link } from "react-router-dom";
import Drawer from "../../components/Drawer";
import InfluencePanel from "../authors/InfluencePanel";
import { formatCount, formatScore } from "../../lib/format";
import type { CommunityGraphNode } from "../../api/communities";

interface Props {
  node: CommunityGraphNode | null;
  communityLabel: string | null;
  onClose: () => void;
}

/** The graph's entity-peek drawer (design-system.md §3, §6: "click a node
 * to open the drawer"). The quick summary is already on the node the
 * person clicked — no request — so that part never shows a loading state.
 * Phase 5 adds the full influence profile (centralities, tie table,
 * Method) below it, which does need its own request; it only mounts once
 * the node's own bridge_score shows a run has happened, so a still-unscored
 * author never fires a request just to redisplay the message the node data
 * already gave for free. */
export default function AuthorPeek({ node, communityLabel, onClose }: Props) {
  return (
    <Drawer open={node !== null} onClose={onClose} title={node ? node.full_name : "Researcher details"}>
      {node && (
        <article>
          <h2 className="font-serif text-xl font-semibold leading-snug">{node.full_name}</h2>
          <p className="mt-1 text-sm">
            {formatCount(node.paper_count)} {node.paper_count === 1 ? "paper" : "papers"} in the corpus
          </p>
          <p className="mt-1 text-sm">
            {node.community_id === null ? (
              <span className="text-muted">Not assigned to a detected community</span>
            ) : (
              <>
                Member of{" "}
                <Link to={`/communities/${node.community_id}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
                  {communityLabel ?? `Community ${node.community_id}`}
                </Link>
                {node.membership_score !== null && <span className="text-muted"> &middot; membership {formatScore(node.membership_score)}</span>}
              </>
            )}
          </p>
          {node.bridge_score !== null ? (
            <p className="mt-1 text-sm">
              Bridge score {formatScore(node.bridge_score)}, touching {formatCount(node.communities_touched ?? 0)} {node.communities_touched === 1 ? "community" : "communities"}
              <span className="block text-xs text-muted">How evenly this researcher&rsquo;s ties spread across communities &mdash; 0 means all in one.</span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">Bridge score not computed yet. Run python -m graph.influence.</p>
          )}
          {node.bridge_score !== null && (
            <div className="mt-4 border-t border-rule pt-4">
              <InfluencePanel authorId={node.author_id} />
            </div>
          )}
          <p className="mt-4 text-sm">
            <Link to={`/authors/${node.author_id}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
              Open full page
            </Link>
          </p>
        </article>
      )}
    </Drawer>
  );
}
