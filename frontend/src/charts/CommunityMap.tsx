import { useState, type KeyboardEvent } from "react";
import type { CommunitySummary } from "../lib/communityMap";
import { useContainerWidth } from "../lib/useContainerWidth";

interface Props {
  summary: CommunitySummary;
  labelOf: (id: number) => string;
  colorOf: (id: number) => string;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

/** Communities drawn individually: the design system colours the eight
 * largest and groups the rest (design-system.md §2). Smaller ones are named
 * in a note under the figure and kept in its table view and CSV. */
export const MAX_DRAWN = 8;
/** Links whose value is printed: the strongest few, plus every link of the
 * selected community. Eight communities have 28 links; printing all 28
 * values would bury the figure. The rest show on hover and in the table. */
export const LABELED_LINKS = 6;
/** Past this many links (five communities have ten) only the strongest
 * DRAWN_LINKS are drawn until a community is selected; a complete graph of
 * eight communities (28 links) is a tangle again. */
export const MAX_LINKS_ALL = 10;
export const DRAWN_LINKS = 8;

// Literal fallbacks keep a downloaded SVG readable outside the app.
const C = {
  ink: "var(--color-ink, #18232f)",
  muted: "var(--color-muted, #55626f)",
  line: "var(--color-muted, #55626f)",
  faint: "var(--color-rule, #d8dde3)",
  sheet: "var(--color-sheet, #ffffff)",
  accent: "var(--color-accent, #1d4f91)",
};

/** The part of every label after a prefix they all share at a " + "
 * boundary ("Federated Learning + Privacy" -> "Privacy" when every label
 * starts "Federated Learning + "). The caption states the dropped prefix. */
export function sharedPrefix(labels: string[]): string {
  if (labels.length < 2) return "";
  const parts = labels.map((l) => l.split(" + "));
  let n = 0;
  while (parts.every((p) => p.length > n + 1 && p[n] === parts[0][n])) n++;
  return n > 0 ? `${parts[0].slice(0, n).join(" + ")} + ` : "";
}

/** Evenly around an ellipse. For an even count the ring is rotated half a
 * step, so four communities sit at the corners. */
export function mapPositions(k: number, cx: number, cy: number, rx: number, ry: number): { x: number; y: number }[] {
  if (k === 1) return [{ x: cx, y: cy }];
  const start = -Math.PI / 2 + (k % 2 === 0 ? Math.PI / k : 0);
  return Array.from({ length: k }, (_, i) => {
    const t = start + (2 * Math.PI * i) / k;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
}

/** Community-level schematic of the collaboration graph, drawn as a journal
 * figure (design-system.md §1, §6): small nodes (area = members) in the
 * community's colour with a hairline ink outline, hairline links whose
 * weight and printed value give the average tie between two communities'
 * members, and a one-line label with the community's internal tie beside
 * each node. Positions are fixed, so the same data always draws the same
 * figure. Nodes are the keyboard stops: Enter selects, Escape clears. */
export default function CommunityMap({ summary, labelOf, colorOf, selectedId, onSelect }: Props) {
  const [ref, width] = useContainerWidth<HTMLDivElement>(760);
  const [status, setStatus] = useState<string | null>(null);
  // summary.communities is largest first, so this keeps the eight largest.
  const communities = summary.communities.slice(0, MAX_DRAWN);
  const hidden = summary.communities.slice(MAX_DRAWN);
  const drawnIds = new Set(communities.map((c) => c.id));
  const links = summary.links.filter((l) => drawnIds.has(l.a) && drawnIds.has(l.b));
  const thinned = links.length > MAX_LINKS_ALL;
  const touches = (l: { a: number; b: number }) => selectedId !== null && (l.a === selectedId || l.b === selectedId);
  // links are strongest first (summarizeCommunities), so slices keep the strongest.
  const visibleLinks = !thinned ? links : selectedId !== null ? links.filter(touches) : links.slice(0, DRAWN_LINKS);
  const labeled = new Set(selectedId !== null ? visibleLinks.filter(touches) : visibleLinks.slice(0, LABELED_LINKS));

  const narrow = width < 600;
  const W = Math.max(300, Math.min(width, 760));
  const many = communities.length > 4;
  const H = communities.length <= 2 ? (narrow ? 200 : 170) : (narrow ? 320 : 300) + (many ? 90 : 0);
  const prefix = sharedPrefix(communities.map((c) => labelOf(c.id)));
  const shortLabel = (id: number) => labelOf(id).slice(prefix.length);
  const maxSize = Math.max(1, ...communities.map((c) => c.size));
  const maxLink = Math.max(0, ...links.map((l) => l.avg));
  const radiusOf = (size: number) => 5 + 7 * Math.sqrt(size / maxSize);
  // Labels go beside nodes on the left and right of the ring and above or
  // below nodes at its top and bottom (placement below), so the ring leaves
  // room on every side.
  const rx = narrow ? W / 2 - 88 : W / 2 - 190;
  const ry = H / 2 - (narrow ? 62 : 52);
  const pos = mapPositions(communities.length, W / 2, H / 2, rx, ry);
  const at = new Map(communities.map((c, i) => [c.id, pos[i]]));
  const byId = new Map(communities.map((c) => [c.id, c]));
  const chars = communities.length === 1 ? 80 : narrow ? 22 : 30;
  const clip = (s: string) => (s.length > chars ? `${s.slice(0, chars - 1)}…` : s);

  const describe = (id: number) => {
    const c = byId.get(id)!;
    const s = links.find((l) => l.a === id || l.b === id);
    return `${labelOf(id)}: ${c.size} ${c.size === 1 ? "member" : "members"}, internal tie ${c.within.toFixed(1)}${
      s ? `; strongest link ${labelOf(s.a === id ? s.b : s.a)}, ${s.avg.toFixed(1)}` : ""
    }`;
  };
  const onKey = (e: KeyboardEvent<SVGGElement>, id: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(selectedId === id ? null : id);
    } else if (e.key === "Escape") onSelect(null);
  };

  if (narrow && many) {
    // A ring of five or more labelled communities does not fit a phone
    // screen; the same facts as a list, largest community first.
    return (
      <div ref={ref} className="w-full">
        <ul className="divide-y divide-rule border-y border-rule text-sm" aria-label="Communities, largest first">
          {summary.communities.map((c) => {
            const s = summary.links.find((l) => l.a === c.id || l.b === c.id);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  aria-pressed={selectedId === c.id}
                  onClick={() => onSelect(selectedId === c.id ? null : c.id)}
                  className={`flex w-full items-start gap-2 px-1 py-2 text-left hover:bg-accent-soft ${selectedId === c.id ? "bg-accent-soft" : ""}`}
                >
                  <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-ink/40" style={{ backgroundColor: colorOf(c.id) }} aria-hidden="true" />
                  <span>
                    <span className="block font-medium">{labelOf(c.id)}</span>
                    <span className="block text-xs text-muted">
                      {c.size} members, internal tie {c.within.toFixed(1)}
                      {s ? `; strongest link ${labelOf(s.a === c.id ? s.b : s.a)}, ${s.avg.toFixed(1)}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-xs text-muted">On a wider screen these communities are drawn as a figure.</p>
      </div>
    );
  }

  return (
    <div ref={ref} className="w-full">
      <p className="min-h-[1.25rem] text-sm text-muted" aria-live="polite">
        {status ?? (links.length > 0 ? "Hover a link for its value. Select a community for its members." : "Select the community for its members.")}
      </p>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label={`Schematic of ${communities.length} research communities and the average tie strength between them`}
        fontSize={12}
        fontFamily="'Hanken Grotesk Variable', system-ui, sans-serif"
        style={{ display: "block", maxWidth: "100%", margin: "0 auto" }}
      >
        {visibleLinks.map((l) => {
          const p = at.get(l.a)!;
          const q = at.get(l.b)!;
          const lit = selectedId === null || touches(l);
          const w = maxLink > 0 ? 0.75 + 2.25 * (l.avg / maxLink) ** 2 : 0.75;
          // Links through the middle of the ring cross each other there, so
          // their values sit a third of the way along instead.
          const mx = (p.x + q.x) / 2 - W / 2;
          const my = (p.y + q.y) / 2 - H / 2;
          const t = Math.hypot(mx, my) < 30 ? 0.3 : 0.5;
          const showValue = labeled.has(l);
          const lx = p.x + (q.x - p.x) * t;
          const ly = p.y + (q.y - p.y) * t;
          const text = l.avg.toFixed(1);
          return (
            <g
              key={`${l.a}-${l.b}`}
              opacity={lit ? 1 : 0.25}
              onMouseEnter={() => setStatus(`${labelOf(l.a)} and ${labelOf(l.b)}: average tie ${l.avg.toFixed(1)} between members`)}
              onMouseLeave={() => setStatus(null)}
            >
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={C.line} strokeWidth={w} data-link-avg={l.avg} />
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="transparent" strokeWidth={12} />
              {showValue && (
                <>
                  <rect x={lx - text.length * 3.4 - 3} y={ly - 8} width={text.length * 6.8 + 6} height={15} fill={C.sheet} />
                  <text x={lx} y={ly + 4} textAnchor="middle" fontSize={11} fill={C.muted} style={{ fontVariantNumeric: "tabular-nums" }}>
                    {text}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {communities.map((c) => {
          const p = at.get(c.id)!;
          const r = radiusOf(c.size);
          const dim = selectedId !== null && selectedId !== c.id;
          // Beside the node on the ring's left and right; above or below it
          // at the ring's top and bottom, where a side label would run over
          // the node's own links. A phone has no side room: always stacked.
          const dx = p.x - W / 2;
          const stacked = narrow || Math.abs(dx) < rx * 0.35;
          const left = dx < 0;
          const above = p.y < H / 2 - 1;
          const name = clip(shortLabel(c.id));
          // On a phone the two columns of labels are close, so the stat
          // wraps onto two short lines instead of one long one.
          const stats = narrow ? [`${c.size} members`, `internal tie ${c.within.toFixed(1)}`] : [`${c.size} members, internal tie ${c.within.toFixed(1)}`];
          const lx = stacked ? p.x : left ? p.x - r - 8 : p.x + r + 8;
          const anchor = stacked ? "middle" : left ? "end" : "start";
          const ly = stacked ? (above ? p.y - r - 8 - stats.length * 14 : p.y + r + 16) : p.y - 2;
          return (
            <g
              key={c.id}
              tabIndex={0}
              role="button"
              aria-pressed={selectedId === c.id}
              aria-label={describe(c.id)}
              onClick={() => onSelect(selectedId === c.id ? null : c.id)}
              onKeyDown={(e) => onKey(e, c.id)}
              onMouseEnter={() => setStatus(describe(c.id))}
              onMouseLeave={() => setStatus(null)}
              onFocus={() => setStatus(describe(c.id))}
              onBlur={() => setStatus(null)}
              className="cmap-node"
              opacity={dim ? 0.4 : 1}
              style={{ cursor: "pointer" }}
            >
              <circle cx={p.x} cy={p.y} r={r + 10} fill="transparent" />
              {selectedId === c.id && <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke={C.accent} strokeWidth={1.5} />}
              <circle cx={p.x} cy={p.y} r={r} fill={colorOf(c.id)} stroke={C.ink} strokeWidth={0.75} />
              <text x={lx} y={ly} textAnchor={anchor} fill={C.ink} fontWeight={600}>
                {name}
              </text>
              {stats.map((t, i) => (
                <text key={i} x={lx} y={ly + 15 + i * 14} textAnchor={anchor} fill={C.muted} fontSize={11}>
                  {t}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
      {thinned ? (
        <p className="mt-1 text-xs text-muted">
          {selectedId !== null
            ? "Showing the selected community's links. Select it again to return to the strongest links."
            : `Only the ${DRAWN_LINKS} strongest of ${links.length} links are drawn; select a community to see all of its links, or view the table for every value.`}
        </p>
      ) : (
        links.length > LABELED_LINKS && (
          <p className="mt-1 text-xs text-muted">
            Values are printed on the {LABELED_LINKS} strongest links; select a community to see all of its links, or view the table for every value.
          </p>
        )
      )}
      {hidden.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          {hidden.length} smaller {hidden.length === 1 ? "community is" : "communities are"} not drawn:{" "}
          {hidden
            .slice(0, 5)
            .map((c) => `${labelOf(c.id)} (${c.size} ${c.size === 1 ? "member" : "members"})`)
            .join(", ")}
          {hidden.length > 5 ? `, and ${hidden.length - 5} more` : ""}. The table view lists every community.
        </p>
      )}
      {prefix && (
        <p className="mt-1 text-xs text-muted">
          Every community here is labelled &ldquo;{prefix.trim()}&rdquo;; the drawing shows the rest of each name.
        </p>
      )}
    </div>
  );
}
