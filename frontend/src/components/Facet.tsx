interface Item {
  key: string | number;
  label: string;
  note?: string;
  count: number;
  onClick?: () => void;
}
interface Props {
  title: string;
  items: Item[];
  empty?: string;
  active?: { label: string; onRemove: () => void };
}

/** Ranked list with count and a proportional bar; click toggles the
 * filter. The active filter, if any, shows as a removable token above the
 * list (design-system.md §4). */
export default function Facet({ title, items, empty, active }: Props) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <section className="border-t border-rule py-3">
      <h3 className="mb-1.5 font-serif text-base font-semibold">{title}</h3>
      {active && (
        <p className="mb-1.5">
          <span className="inline-flex items-center gap-1.5 bg-accent-soft py-0.5 pl-2.5 pr-1 text-sm">
            {active.label}
            <button type="button" onClick={active.onRemove} aria-label={`Remove filter: ${active.label}`} className="px-1.5 py-0.5 hover:bg-accent hover:text-white">
              &times;
            </button>
          </span>
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted">{empty ?? "Nothing to show."}</p>
      ) : (
        <ul>
          {items.map((it) => (
            <li key={it.key}>
              <button
                type="button"
                onClick={it.onClick}
                disabled={!it.onClick}
                className="flex w-full items-baseline justify-between gap-3 px-1 py-1 text-left text-sm hover:bg-accent-soft disabled:hover:bg-transparent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{it.label}</span>
                  {it.note && <span className="block truncate text-xs text-muted">{it.note}</span>}
                  <span className="mt-0.5 block h-1 w-full bg-rule">
                    <span className="block h-full bg-bar" style={{ width: `${(it.count / max) * 100}%` }} />
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-muted">{it.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
