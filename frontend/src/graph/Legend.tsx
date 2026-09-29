import type { LegendEntry } from "../lib/graph";
import { formatCount } from "../lib/format";

interface Props {
  entries: LegendEntry[];
  /** communityId of the isolated entry, or "other"/"unassigned" for those
   * buckets, or null when nothing is isolated. Isolating is a display
   * filter (dims everything else), not a re-fetch. */
  isolated: number | "other" | "unassigned" | null;
  onIsolate: (key: number | "other" | "unassigned" | null) => void;
}

function keyOf(e: LegendEntry): number | "other" | "unassigned" {
  if (e.isOther) return "other";
  if (e.communityId === null) return "unassigned";
  return e.communityId;
}

/** Direct, clickable legend naming each community by its label — never
 * "Community 3" as the only identifier (design-system.md §6). Clicking an
 * entry isolates it; clicking the same entry again clears the isolation. */
export default function Legend({ entries, isolated, onIsolate }: Props) {
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm" aria-label="Communities in this graph">
      {entries.map((e) => {
        const key = keyOf(e);
        const active = isolated === key;
        return (
          <li key={`${e.isOther ? "other" : e.communityId ?? "unassigned"}`}>
            <button
              type="button"
              onClick={() => onIsolate(active ? null : key)}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 ${active ? "border-accent bg-accent-soft" : "border-transparent hover:bg-accent-soft"}`}
            >
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.color }} aria-hidden="true" />
              <span className={e.isOther || e.communityId === null ? "italic text-muted" : ""}>{e.label}</span>
              <span className="tabular-nums text-muted">({formatCount(e.memberCount)})</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
