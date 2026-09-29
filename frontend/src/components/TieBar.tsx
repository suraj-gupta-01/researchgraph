const COMMUNITY_COLORS = [
  "bg-community-1",
  "bg-community-2",
  "bg-community-3",
  "bg-community-4",
  "bg-community-5",
  "bg-community-6",
  "bg-community-7",
  "bg-community-8",
];

interface Tie {
  community_id: number;
  label: string | null;
  weight: number;
  share: number;
}

interface Props {
  ties: Tie[];
  /** Colour per community (a CSS colour). When given, a community keeps one
   * colour across authors, matching a chart on the same page; without it,
   * segments are coloured by share rank, as before. */
  colorOf?: (communityId: number) => string;
}

/** Stacked horizontal bar of an author's tie share per community, colored
 * by community and labeled directly (never a legend-only key). A `label`
 * of null means the community was since replaced by a newer run. */
export default function TieBar({ ties, colorOf }: Props) {
  const swatch = (t: Tie, i: number) =>
    colorOf ? { className: "", style: { backgroundColor: colorOf(t.community_id) } } : { className: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length], style: {} };
  if (ties.length === 0) return <p className="text-sm text-muted">No community ties recorded.</p>;
  const sorted = [...ties].sort((a, b) => b.share - a.share);
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden bg-rule" role="img" aria-label="Tie share per community">
        {sorted.map((t, i) => (
          <div
            key={t.community_id}
            className={swatch(t, i).className}
            style={{ ...swatch(t, i).style, width: `${Math.max(0, t.share) * 100}%` }}
            title={`${t.label ?? "Replaced community"}: ${Math.round(t.share * 100)}%`}
          />
        ))}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-sm">
        {sorted.map((t, i) => (
          <li key={t.community_id} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 ${swatch(t, i).className}`} style={swatch(t, i).style} aria-hidden="true" />
            <span className={t.label ? "" : "text-muted italic"}>{t.label ?? "Replaced by a newer run"}</span>
            <span className="ml-auto tabular-nums text-muted">{Math.round(t.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
