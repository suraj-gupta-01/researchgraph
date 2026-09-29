import { useEffect, useRef, useState } from "react";
import { listTopics, type TopicSummary } from "../api/topics";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  id: string;
  label: string;
}

const RECENT_KEY = "researchgraph.recentScopes";

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function pushRecent(q: string) {
  try {
    const next = [q, ...readRecent().filter((r) => r !== q)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable (private browsing) — recent scopes are a convenience, not required */
  }
}

/** The global topic-scope input (top bar). Suggests matching topics from
 * GET /topics?q= plus the viewer's recent scopes. Submitting commits the
 * free-text query as-is — suggestions are a shortcut, not a requirement,
 * since /search/overview accepts any free text. */
export default function Typeahead({ value, onChange, onSubmit, placeholder, id, label }: Props) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<TopicSummary[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || value.trim().length < 2) {
      setOptions([]);
      return;
    }
    const ctl = new AbortController();
    listTopics(value.trim(), undefined, 0, 6, ctl.signal)
      .then((r) => setOptions(r.items))
      .catch(() => setOptions([]));
    return () => ctl.abort();
  }, [value, open]);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const commit = (q: string) => {
    const t = q.trim();
    if (!t) return;
    pushRecent(t);
    setOpen(false);
    onSubmit(t);
  };

  const recent = readRecent().filter((r) => r !== value);
  const showList = open && (options.length > 0 || (value.trim().length < 2 && recent.length > 0));

  return (
    <div ref={boxRef} className="relative min-w-[260px] flex-1">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          commit(value);
        }}
      >
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-listbox`}
          className="min-w-0 flex-1 rounded-sm border border-rule-strong bg-paper px-3 py-2 text-base placeholder:text-faint"
        />
        <button type="submit" className="rounded-sm bg-accent px-4 py-2 font-medium text-white hover:bg-ink">
          Search
        </button>
      </form>
      {showList && (
        <ul id={`${id}-listbox`} role="listbox" className="absolute z-20 mt-1 w-full max-w-md border border-rule-strong bg-sheet text-sm shadow-lg">
          {options.map((t) => (
            <li key={t.topic_id} role="option" aria-selected={false}>
              <button type="button" onClick={() => commit(t.topic_name)} className="block w-full px-3 py-2 text-left hover:bg-accent-soft">
                {t.topic_name} <span className="text-muted">({t.paper_count} papers)</span>
              </button>
            </li>
          ))}
          {options.length === 0 &&
            recent.map((r) => (
              <li key={r} role="option" aria-selected={false}>
                <button type="button" onClick={() => commit(r)} className="block w-full px-3 py-2 text-left text-muted hover:bg-accent-soft hover:text-ink">
                  {r}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
