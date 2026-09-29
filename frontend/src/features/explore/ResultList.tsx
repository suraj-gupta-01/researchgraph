import type { PaperSummary, PaperSort } from "../../api/search";
import Pagination from "../../components/Pagination";

interface Props {
  items: PaperSummary[];
  total: number;
  offset: number;
  limit: number;
  selected?: number;
  loading: boolean;
  sort: PaperSort;
  onSort: (s: PaperSort) => void;
  onSelect: (id: number) => void;
  onPage: (offset: number) => void;
}

const authorLine = (p: PaperSummary) => {
  const shown = p.authors.slice(0, 3).join(", ");
  const more = p.author_count - Math.min(p.authors.length, 3);
  return more > 0 ? `${shown} and ${more} more` : shown || "Authors not listed";
};

/** The ranked, paginated paper list on the Explore results page (F1).
 * Sort is always sent to the server (relevance, citations, year, title) —
 * never re-ordered client-side. */
export default function ResultList({ items, total, offset, limit, selected, loading, sort, onSort, onSelect, onPage }: Props) {
  const end = Math.min(offset + limit, total);
  return (
    <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={loading}>
      <div className="mb-2 flex items-center justify-between gap-4 text-sm">
        <p className="text-muted">{total === 0 ? "No papers" : `Papers ${offset + 1}\u2013${end} of ${total}`}</p>
        <label className="flex items-center gap-2 text-muted">
          Sort by
          <select value={sort} onChange={(e) => onSort(e.target.value as PaperSort)} className="rounded-sm border border-rule-strong bg-sheet px-2 py-1 text-ink">
            <option value="relevance">Relevance</option>
            <option value="citations">Most cited</option>
            <option value="year">Newest</option>
            <option value="title">Title</option>
          </select>
        </label>
      </div>
      <ol className="border-t border-rule">
        {items.map((p) => (
          <li key={p.paper_id} className="border-b border-rule">
            <button
              type="button"
              onClick={() => onSelect(p.paper_id)}
              aria-current={selected === p.paper_id}
              className={`block w-full px-2 py-3 text-left hover:bg-accent-soft ${selected === p.paper_id ? "bg-accent-soft" : ""}`}
            >
              <span className="block font-serif text-[17px] font-semibold leading-snug">{p.title}</span>
              <span className="mt-1 block text-sm text-ink">{authorLine(p)}</span>
              <span className="mt-0.5 block text-sm text-muted">
                {p.venue_name ? `${p.venue_name}, ` : ""}
                {p.publication_year}. Cited {p.citation_count.toLocaleString()} {p.citation_count === 1 ? "time" : "times"}.
              </span>
            </button>
          </li>
        ))}
      </ol>
      {total > limit && <Pagination offset={offset} limit={limit} total={total} onPage={onPage} />}
    </div>
  );
}
