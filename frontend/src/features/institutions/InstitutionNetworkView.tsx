import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import EntityLink from "../../components/EntityLink";
import NoticeBar from "../../components/NoticeBar";
import NotComputed from "../../components/NotComputed";
import { ApiError } from "../../api/client";
import { institutionNetwork, type InstitutionNetwork } from "../../api/institutions";
import { formatCount } from "../../lib/format";
import { getNum, setNum } from "../../lib/urlState";
import InstitutionNetworkGraph from "./InstitutionNetworkGraph";

const LIMIT = 150;
const MIN_SHARED_OPTIONS = [1, 2, 3, 5, 10];

/** /institutions/network (G5): the corpus-wide institution collaboration
 * network. Nodes are institutions (size = papers, color = country), edges
 * are COLLABORATION pairs weighted by shared papers. `min` (the server's
 * min_shared) and the selected institution `sel` live in the URL. The
 * network is not topic-scoped: COLLABORATION has no topic dimension, so it
 * says so rather than silently ignoring the top-bar scope. */
export default function InstitutionNetworkView() {
  const [params, setParams] = useSearchParams();
  const minShared = Math.max(1, getNum(params, "min") ?? 1);
  const selected = getNum(params, "sel") ?? null;

  const [network, setNetwork] = useState<InstitutionNetwork | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setNetwork(null);
    setError(null);
    institutionNetwork({ limit: LIMIT, minShared }, ctl.signal)
      .then(setNetwork)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [minShared]);

  const patch = (key: string, value: number | undefined) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        setNum(next, key, value);
        return next;
      },
      { replace: true },
    );

  const selectedNode = network?.nodes.find((n) => n.institution_id === selected) ?? null;
  const partners = selectedNode && network
    ? network.edges
        .filter((e) => e.source === selectedNode.institution_id || e.target === selectedNode.institution_id)
        .map((e) => ({ id: e.source === selectedNode.institution_id ? e.target : e.source, shared: e.shared_papers }))
        .sort((a, b) => b.shared - a.shared)
        .slice(0, 8)
    : [];
  const nameOf = new Map(network?.nodes.map((n) => [n.institution_id, n.name]) ?? []);

  return (
    <div className="pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">Institution collaboration network</h1>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        Institutions linked by the papers their authors wrote together. This covers the whole corpus: collaboration pairs are not recorded per topic, so the topic scope above does not narrow it.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5 text-muted">
          At least
          <select value={minShared} onChange={(e) => patch("min", Number(e.target.value) === 1 ? undefined : Number(e.target.value))} className="border border-rule-strong bg-sheet px-1.5 py-1 text-ink">
            {MIN_SHARED_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          shared {minShared === 1 ? "paper" : "papers"} per link
        </label>
      </div>

      {error && (
        <p role="alert" className="mt-5 text-sm text-warn">
          {error.kind === "network" ? `${error.message}. Start the stack with docker compose up -d, then reload.` : `Could not load the network (${error.message}).`}
        </p>
      )}
      {!network && !error && <p className="mt-5 text-sm text-muted">Loading network&hellip;</p>}

      {network && network.nodes.length === 0 && (
        <div className="mt-5">
          {minShared > 1 ? (
            <p className="text-sm text-muted">No pair of institutions shares {minShared} or more papers. Lower the threshold to see weaker links.</p>
          ) : (
            <NotComputed analysis="The institution collaboration network" command="python -m ingestion.derive_collaboration" />
          )}
        </div>
      )}

      {network && network.nodes.length > 0 && (
        <div className="mt-5">
          {network.truncated && (
            <NoticeBar kind="info">
              Showing the {formatCount(network.nodes.length)} most-collaborative of {formatCount(network.total_candidates)} institutions, ranked by total shared papers. Raise the threshold to thin the graph.
            </NoticeBar>
          )}
          <InstitutionNetworkGraph network={network} selected={selected} onSelect={(id) => patch("sel", id ?? undefined)} />

          {selectedNode && (
            <aside className="mt-4 border border-rule-strong bg-sheet px-4 py-3 text-sm" aria-label="Selected institution">
              <p className="font-serif text-base font-semibold">
                <EntityLink kind="institution" id={selectedNode.institution_id}>{selectedNode.name}</EntityLink>
              </p>
              <p className="mt-1 text-muted">
                {selectedNode.country ?? "Unknown country"} &middot; {formatCount(selectedNode.paper_count)} papers &middot; {formatCount(selectedNode.collaborators)} partners in this graph
              </p>
              {partners.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {partners.map((p) => (
                    <li key={p.id} className="flex items-baseline justify-between gap-3">
                      <EntityLink kind="institution" id={p.id}>{nameOf.get(p.id) ?? `Institution ${p.id}`}</EntityLink>
                      <span className="tabular-nums text-muted">{formatCount(p.shared)} shared</span>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}

          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted hover:text-ink">Method</summary>
            <p className="mt-1.5 max-w-[68ch] border-l-2 border-rule pl-3 text-muted">
              A pair is linked when at least one author of each is on the same paper, counting each paper once. Each author is credited to the institution listed on that paper. The matrix shades each pair by its shared papers on a square-root scale, so weaker ties stay visible next to the strongest. Institutions with no link at this threshold are left out.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
