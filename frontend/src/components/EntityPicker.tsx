import { useEffect, useId, useState, type KeyboardEvent } from "react";
import type { EntityRef } from "../lib/urlState";

interface Props {
  label: string;
  value: EntityRef | undefined;
  onChange: (v: EntityRef | undefined) => void;
  /** Server search; called with the typed text, aborted when it changes. */
  search: (q: string, signal: AbortSignal) => Promise<EntityRef[]>;
  placeholder?: string;
}

/** Pick one entity (topic, paper, ...) by id through a server search: a
 * combobox with a listbox of matches, arrow keys + Enter to choose. The
 * chosen entity shows as a chip with a clear button. Used where an endpoint
 * needs an id, not free text (the query lab's parameters). */
export default function EntityPicker({ label, value, onChange, search, placeholder }: Props) {
  const id = useId();
  const [text, setText] = useState("");
  const [options, setOptions] = useState<EntityRef[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setOptions([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      search(q, ctl.signal)
        .then((r) => {
          setOptions(r);
          setActive(0);
        })
        .catch(() => setOptions([]));
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const choose = (e: EntityRef) => {
    onChange(e);
    setText("");
    setOptions([]);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!options.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === "Escape") {
      setOptions([]);
    }
  };

  return (
    <div className="flex flex-col text-sm">
      <label htmlFor={id}>{label}</label>
      {value ? (
        <span className="mt-1 inline-flex max-w-full items-center gap-2 self-start rounded-sm border border-accent bg-accent-soft px-2 py-1">
          <span className="truncate">{value.name}</span>
          <button type="button" onClick={() => onChange(undefined)} aria-label={`Clear ${label}`} className="text-muted hover:text-ink">
            &times;
          </button>
        </span>
      ) : (
        <div className="relative mt-1">
          <input
            id={id}
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={options.length ? `${id}-opt-${active}` : undefined}
            aria-autocomplete="list"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder ?? "Type to search"}
            className="w-64 max-w-full rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5"
          />
          {options.length > 0 && (
            <ul id={`${id}-list`} role="listbox" className="absolute z-20 mt-1 max-h-64 w-80 max-w-[90vw] overflow-auto border border-rule-strong bg-sheet shadow-sm">
              {options.map((o, i) => (
                <li
                  key={o.id}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(o);
                  }}
                  className={`cursor-pointer px-2.5 py-1.5 ${i === active ? "bg-accent-soft" : ""}`}
                >
                  {o.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
