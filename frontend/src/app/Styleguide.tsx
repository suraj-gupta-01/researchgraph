import { useState } from "react";
import Figure from "../components/Figure";
import Method from "../components/Method";
import DataTable from "../components/DataTable";
import Pagination from "../components/Pagination";
import Facet from "../components/Facet";
import NoticeBar from "../components/NoticeBar";
import NotComputed from "../components/NotComputed";
import TrendBadge from "../components/TrendBadge";
import EntityLink from "../components/EntityLink";
import Drawer from "../components/Drawer";
import StatusDot from "../components/StatusDot";
import Sparkline from "../components/Sparkline";
import MetricBar from "../components/MetricBar";
import TieBar from "../components/TieBar";
import CommunityMap from "../charts/CommunityMap";
import { COMMUNITY_NONE_COLOR, COMMUNITY_PALETTE } from "../lib/graph";
import type { CommunitySummary } from "../lib/communityMap";

const YEARS = [2019, 2020, 2021, 2022, 2023, 2024];
const DEMO_ROWS = [
  { id: 1, name: "A. Researcher", papers: 12, citations: 340 },
  { id: 2, name: "B. Scholar", papers: 8, citations: 210 },
];


const DEMO_TOPICS = ["Differential Privacy", "Edge Computing", "Clinical Data", "Aggregation", "Personalization", "Secure Aggregation Protocols", "Model Compression", "Recommendation", "Graph Neural Networks", "Blockchain", "Speech", "Vision Transformers"];

/** A deterministic community summary with k communities of uneven size,
 * for checking the community map's layout at counts other than the dev
 * corpus's four. */
function demoCommunities(k: number, sharedPrefix = true): { summary: CommunitySummary; labelOf: (id: number) => string } {
  const communities = Array.from({ length: k }, (_, i) => ({ id: i + 1, size: Math.max(3, 24 - i * 2 - (i % 3)), within: 12 + ((i * 7) % 23) }));
  const links = [];
  for (let a = 1; a <= k; a++) for (let b = a + 1; b <= k; b++) links.push({ a, b, avg: 2 + ((a * 5 + b * 3) % 13) + (a === 1 ? 3 : 0) });
  links.sort((x, y) => y.avg - x.avg);
  const labelOf = (id: number) => (sharedPrefix ? `Federated Learning + ${DEMO_TOPICS[id - 1]}` : DEMO_TOPICS[id - 1]);
  return { summary: { communities, links, unassigned: 0 }, labelOf };
}
const demoColor = (id: number) => (id <= COMMUNITY_PALETTE.length ? COMMUNITY_PALETTE[id - 1] : COMMUNITY_NONE_COLOR);

function CommunityMapDemo({ k, sharedPrefix }: { k: number; sharedPrefix?: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  const { summary, labelOf } = demoCommunities(k, sharedPrefix);
  return (
    <div className="w-full max-w-[760px] border border-rule-strong bg-sheet p-4" data-demo={`community-map-${k}`}>
      <p className="mb-1 text-sm font-semibold">{k} {k === 1 ? "community" : "communities"}</p>
      <CommunityMap summary={summary} labelOf={labelOf} colorOf={demoColor} selectedId={selected} onSelect={setSelected} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10 border-t border-rule pt-4">
      <h2 className="mb-3 font-serif text-xl font-semibold">{title}</h2>
      <div className="flex flex-wrap items-start gap-6">{children}</div>
    </section>
  );
}

/** Styleguide: development builds only. Renders every Phase 0 primitive in
 * every state so a visual review does not require wiring a real page.
 * design-system.md §4 lists the full inventory; phases.md Phase 0 "Build"
 * step 7. */
export default function Styleguide() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="pb-16">
      <h1 className="mb-1 font-serif text-2xl font-semibold">Styleguide</h1>
      <p className="mb-6 text-sm text-muted">Development-only visual test bench for every Phase 0 primitive.</p>

      <Section title="TrendBadge">
        <TrendBadge label="Emerging" />
        <TrendBadge label="Declining" />
        <TrendBadge label="Converging" />
        <TrendBadge label="Stable" />
        <TrendBadge label="Emerging" isNew />
      </Section>

      <Section title="NoticeBar">
        <div className="w-full space-y-2">
          <NoticeBar kind="degraded">Abstract search is offline, so results come from titles and topic tags only.</NoticeBar>
          <NoticeBar kind="stale">This community's label evidence is from a previous run.</NoticeBar>
          <NoticeBar kind="info">Every feature has a corresponding surface.</NoticeBar>
        </div>
      </Section>

      <Section title="NotComputed">
        <NotComputed analysis="Research communities" command="python -m graph.communities" />
        <NotComputed analysis="Researcher influence" command="python -m graph.influence" prerequisite="graph.communities" />
      </Section>

      <Section title="EntityLink">
        <EntityLink kind="paper" id={1}>
          Federated averaging for non-IID data
        </EntityLink>
        <EntityLink kind="author" id={1}>
          A. Researcher
        </EntityLink>
        <EntityLink kind="institution" id={1}>
          Example University
        </EntityLink>
      </Section>

      <Section title="Facet">
        <div className="w-64">
          <Facet
            title="Authors"
            active={{ label: "A. Researcher", onRemove: () => {} }}
            items={[
              { key: 1, label: "A. Researcher", count: 12, onClick: () => {} },
              { key: 2, label: "B. Scholar", count: 8, onClick: () => {} },
            ]}
          />
          <Facet title="Empty facet" items={[]} empty="Nothing to show." />
        </div>
      </Section>

      <Section title="DataTable">
        <div className="w-full max-w-md">
          <DataTable
            columns={[
              { key: "name", label: "Author", render: (r) => r.name },
              { key: "papers", label: "Papers", align: "right", sortable: true, render: (r) => r.papers },
              { key: "citations", label: "Citations", align: "right", sortable: true, render: (r) => r.citations },
            ]}
            rows={DEMO_ROWS}
            rowKey={(r) => r.id}
            sort="citations"
            sortDesc
            onSort={() => {}}
            onRowActivate={() => {}}
          />
        </div>
      </Section>

      <Section title="Pagination">
        <div className="w-full max-w-md">
          <Pagination offset={20} limit={20} total={132} onPage={() => {}} onLimit={() => {}} />
        </div>
      </Section>

      <Section title="Sparkline">
        <Sparkline
          points={[
            { year: 2019, value: 4 },
            { year: 2020, value: 6 },
            { year: 2021, value: null },
            { year: 2022, value: 9 },
            { year: 2023, value: 14 },
          ]}
        />
      </Section>

      <Section title="MetricBar">
        <div className="w-72">
          <MetricBar label="Betweenness" value={0.041} max={0.1} rank="3rd of 48" explanation="How often this author sits on the shortest collaboration path between two others." />
        </div>
      </Section>

      <Section title="TieBar">
        <div className="w-72">
          <TieBar
            ties={[
              { community_id: 1, label: "Federated learning + privacy", weight: 3, share: 0.6 },
              { community_id: 2, label: "Federated learning + healthcare", weight: 2, share: 0.4 },
            ]}
          />
        </div>
      </Section>

      <Section title="Method">
        <div className="w-96">
          <Method algorithm="louvain(resolution=1,seed=42)" detectionDate="2026-01-15T00:00:00Z" explanation="Communities are detected with the Louvain algorithm over the author collaboration graph." />
        </div>
      </Section>

      <Section title="Figure">
        <div className="w-full max-w-lg">
          <Figure
            title="Papers per year"
            caption='Papers per year for "federated learning", 2019 to 2023. Demo data.'
            svg={
              <svg viewBox="0 0 200 60" className="w-full">
                {YEARS.slice(0, 5).map((y, i) => (
                  <rect key={y} x={i * 40 + 4} y={60 - (i + 1) * 10} width={30} height={(i + 1) * 10} fill="var(--color-bar)" />
                ))}
              </svg>
            }
            tableView={
              <table className="w-full text-sm">
                <tbody>
                  {YEARS.slice(0, 5).map((y, i) => (
                    <tr key={y}>
                      <td>{y}</td>
                      <td className="text-right tabular-nums">{(i + 1) * 10}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
            method={{ algorithm: null, explanation: "Snapshot counts computed from PAPER_TOPIC and TOPIC_SNAPSHOT." }}
          />
        </div>
      </Section>

      <Section title="StatusDot">
        <StatusDot />
      </Section>

      <Section title="CommunityMap at different community counts">
        {[1, 2, 3, 5, 6, 8].map((k) => (
          <CommunityMapDemo key={k} k={k} sharedPrefix={k !== 3} />
        ))}
        <CommunityMapDemo k={12} />
      </Section>

      <Section title="Drawer">
        <button type="button" onClick={() => setDrawerOpen(true)} className="rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-accent-soft">
          Open drawer
        </button>
        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Demo drawer">
          <p className="text-sm">Focus-trapped drawer content. Press Escape to close.</p>
        </Drawer>
      </Section>
    </div>
  );
}
