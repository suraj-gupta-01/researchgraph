import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import EntityLink from "../../components/EntityLink";
import Pagination from "../../components/Pagination";
import { ApiError } from "../../api/client";
import {
  institutionCollaborators,
  institutionNetwork,
  type Collaborator,
  type InstitutionNetwork,
} from "../../api/institutions";
import { formatCount } from "../../lib/format";
import { sharedWithCentre } from "../../lib/institutionNetwork";
import { getNum, setNum } from "../../lib/urlState";
import InstitutionNetworkGraph from "./InstitutionNetworkGraph";

const PAGE_SIZE = 10;
const EGO_LIMIT = 60;

interface Props {
  institutionId: number;
  name: string;
}

/** Institution page, Phase 7: who this institution publishes with. The
 * table is /institutions/{id}/collaborators (server-ranked by shared
 * papers, paginated; `coff` in the URL); the ego network is one
 * /institutions/network?center_id= request, which also returns the ties
 * among the partners themselves -- never one request per partner. */
export default function CollaboratorsPanel({ institutionId, name }: Props) {
  const [params, setParams] = useSearchParams();
  const offset = getNum(params, "coff") ?? 0;

  const [rows, setRows] = useState<{ items: Collaborator[]; total: number } | null>(null);
  const [rowsError, setRowsError] = useState<ApiError | null>(null);
  const [ego, setEgo] = useState<InstitutionNetwork | null>(null);
  const [egoError, setEgoError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setRowsError(null);
    institutionCollaborators(institutionId, offset, PAGE_SIZE, ctl.signal)
      .then((r) => setRows({ items: r.items, total: r.total }))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setRowsError(e as ApiError);
      });
    return () => ctl.abort();
  }, [institutionId, offset]);

  useEffect(() => {
    const ctl = new AbortController();
    setEgo(null);
    setEgoError(null);
    setSelected(null);
    institutionNetwork({ centerId: institutionId, limit: EGO_LIMIT }, ctl.signal)
      .then(setEgo)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setEgoError(e as ApiError);
      });
    return () => ctl.abort();
  }, [institutionId]);

  const setOffset = (next: number) => {
    const p = new URLSearchParams(params);
    setNum(p, "coff", next === 0 ? undefined : next);
    setParams(p, { replace: true });
  };

  const columns: Column<Collaborator>[] = [
    { key: "name", label: "Institution", render: (c) => <EntityLink kind="institution" id={c.institution_id}>{c.name}</EntityLink> },
    { key: "country", label: "Country", render: (c) => c.country ?? <span className="text-muted">Unknown</span> },
    { key: "shared", label: "Shared papers", align: "right", render: (c) => formatCount(c.shared_papers) },
  ];

  const selectedNode = ego?.nodes.find((n) => n.institution_id === selected && n.institution_id !== institutionId) ?? null;

  return (
    <section className="mt-8" aria-labelledby="collab-heading">
      <h2 id="collab-heading" className="font-serif text-lg font-semibold">Collaborating institutions</h2>
      <p className="mt-1 max-w-[68ch] text-sm text-muted">
        Institutions whose authors appear on the same papers as {name}&rsquo;s. A pair counts a paper once, however many authors each side has on it.
      </p>

      {rowsError && <p role="alert" className="mt-3 text-sm text-warn">Could not load collaborators ({rowsError.message}).</p>}
      {!rows && !rowsError && <p className="mt-3 text-sm text-muted">Loading collaborators&hellip;</p>}
      {rows && rows.total === 0 && (
        <p className="mt-3 max-w-xl text-sm text-muted">
          No shared papers with another institution. Either every paper here has authors from this institution only, or collaboration pairs have not been derived yet (<code className="font-mono text-[13px]">python -m ingestion.derive_collaboration</code>, run by seed_dev and run_ingestion).
        </p>
      )}
      {rows && rows.total > 0 && (
        <div className="mt-3">
          <DataTable columns={columns} rows={rows.items} rowKey={(c) => c.institution_id} caption={`Institutions collaborating with ${name}`} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={rows.total} onPage={setOffset} />
        </div>
      )}

      {rows && rows.total > 0 && (
        <div className="mt-6">
          <h3 className="font-serif text-base font-semibold">Collaboration neighborhood</h3>
          <p className="mt-1 max-w-[68ch] text-sm text-muted">
            {name} (first row, outlined) and its partners, plus the partners&rsquo; ties with one another.{" "}
            <Link to={`/institutions/network`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
              Full institution network
            </Link>
          </p>
          {egoError && <p role="alert" className="mt-3 text-sm text-warn">Could not load the network ({egoError.message}).</p>}
          {!ego && !egoError && <p className="mt-3 text-sm text-muted">Loading network&hellip;</p>}
          {ego && (
            <div className="mt-3">
              {ego.truncated && (
                <p className="mb-2 text-sm text-muted">
                  Showing the {formatCount(ego.nodes.length - 1)} strongest of {formatCount(ego.total_candidates - 1)} partners; the table above lists all of them.
                </p>
              )}
              <InstitutionNetworkGraph network={ego} selected={selected} onSelect={setSelected} height={380} />
              {selectedNode && (
                <div className="mt-3 border border-rule-strong bg-sheet px-4 py-3 text-sm" role="status">
                  <p>
                    <EntityLink kind="institution" id={selectedNode.institution_id}>{selectedNode.name}</EntityLink>
                    {selectedNode.country ? <span className="text-muted"> &middot; {selectedNode.country}</span> : null}
                  </p>
                  <p className="mt-1 text-muted">
                    {formatCount(sharedWithCentre(ego.edges, institutionId, selectedNode.institution_id))} papers shared with {name} &middot; {formatCount(selectedNode.paper_count)} papers in total
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
