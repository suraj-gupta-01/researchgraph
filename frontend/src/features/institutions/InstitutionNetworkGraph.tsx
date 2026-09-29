import { useMemo, useState } from "react";
import AdjacencyMatrix, { type MatrixNode } from "../../charts/AdjacencyMatrix";
import DataTable, { type Column } from "../../components/DataTable";
import EntityLink from "../../components/EntityLink";
import LegendList from "../../graph/Legend";
import type { InstitutionNetwork, InstitutionNetworkNode } from "../../api/institutions";
import { formatCount } from "../../lib/format";
import { buildCategoricalLegend, matchesCategory, type IsolationKey } from "../../lib/graph";
import { countryKeys, matrixOrder } from "../../lib/institutionNetwork";

interface Props {
  network: InstitutionNetwork;
  selected: number | null;
  onSelect: (id: number | null) => void;
  /** Kept for callers; the matrix sizes itself to its content. */
  height?: number;
}

/** The institution collaboration network (G5) as an adjacency matrix: one
 * row and column per institution, cell shade = papers the pair shared.
 * This network is close to complete (nearly every institution pair
 * collaborates), and a force-directed drawing of it collapsed into an
 * overlapping blob with every link hidden; a matrix gives each pair its own
 * cell. Rows run from the most collaborative institution down (the ego
 * network's own institution first, outlined). Chips mark countries, as the
 * legend does. Used full-page on /institutions/network and as the ego
 * network on each institution page. The list toggle is the non-visual
 * alternative (design-system.md §6). */
export default function InstitutionNetworkGraph({ network, selected, onSelect }: Props) {
  const [isolated, setIsolated] = useState<IsolationKey>(null);
  const [asList, setAsList] = useState(false);

  const nodes = network.nodes;
  const countries = useMemo(() => countryKeys(nodes), [nodes]);
  const categoryOf = useMemo(() => (n: InstitutionNetworkNode) => countries.keyOf(n.country), [countries]);
  const { legend, colorOf } = useMemo(
    () => buildCategoricalLegend(nodes, categoryOf, countries.labelOf, { noneLabel: "Unknown country", otherLabel: "Other countries" }),
    [nodes, categoryOf, countries],
  );
  const order = useMemo(() => matrixOrder(nodes, network.center_id ?? null), [nodes, network.center_id]);
  const matrixNodes: MatrixNode[] = order.map((n) => ({
    id: n.institution_id,
    label: n.country ? `${n.name} (${n.country})` : n.name,
    color: colorOf(categoryOf(n)),
    group: categoryOf(n),
    dimmed: isolated !== null && !matchesCategory(n, isolated, categoryOf, colorOf),
  }));

  const columns: Column<InstitutionNetworkNode>[] = [
    { key: "name", label: "Institution", render: (n) => <EntityLink kind="institution" id={n.institution_id}>{n.name}</EntityLink> },
    { key: "country", label: "Country", render: (n) => n.country ?? <span className="text-muted">Unknown</span> },
    { key: "papers", label: "Papers", align: "right", render: (n) => formatCount(n.paper_count) },
    { key: "partners", label: "Partners shown", align: "right", render: (n) => formatCount(n.collaborators) },
    { key: "shared", label: "Shared papers", align: "right", render: (n) => formatCount(n.shared_papers) },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LegendList entries={legend} isolated={isolated} onIsolate={setIsolated} />
        <button type="button" onClick={() => setAsList((v) => !v)} className="shrink-0 rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-accent-soft">
          {asList ? "View as matrix" : "View as list"}
        </button>
      </div>
      {!asList && (
        <p className="mt-1 text-xs text-muted">
          Each cell is one pair of institutions; darker blue means more papers written together. Chips mark countries.
          {network.center_id != null ? " The outlined row and column are this institution." : ""}
        </p>
      )}
      <div className="mt-3">
        {asList ? (
          <DataTable columns={columns} rows={order} rowKey={(n) => n.institution_id} caption="Institutions in this network" onRowActivate={(n) => onSelect(n.institution_id)} />
        ) : (
          <AdjacencyMatrix
            nodes={matrixNodes}
            edges={network.edges.map((e) => ({ source: e.source, target: e.target, weight: e.shared_papers }))}
            weightName="shared papers"
            formatWeight={formatCount}
            showValues
            highlightId={network.center_id ?? null}
            selectedId={selected}
            onSelect={(id) => onSelect(id === selected ? null : id)}
            ariaLabel={`Institution collaboration matrix: ${nodes.length} institutions, ${network.edges.length} collaborating pairs`}
            idleStatus="Hover a cell for the pair's shared papers. Click an institution for its details."
          />
        )}
      </div>
    </div>
  );
}
