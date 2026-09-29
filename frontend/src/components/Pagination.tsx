import { formatPageRange } from "../lib/format";

interface Props {
  offset: number;
  limit: number;
  total: number;
  onPage: (offset: number) => void;
  onLimit?: (limit: number) => void;
  pageSizes?: number[];
}

/** "21 to 40 of 132", previous/next, optional page-size control. Callers
 * reset to page 1 (offset 0) themselves when filters change — Pagination
 * only renders the current page. */
export default function Pagination({ offset, limit, total, onPage, onLimit, pageSizes = [20, 50, 100] }: Props) {
  const end = Math.min(offset + limit, total);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="text-muted">{total === 0 ? "0 of 0" : formatPageRange(offset, limit, total)}</p>
      <div className="flex items-center gap-2">
        {onLimit && (
          <label className="flex items-center gap-1.5 text-muted">
            Per page
            <select
              value={limit}
              onChange={(e) => onLimit(Number(e.target.value))}
              className="rounded-sm border border-rule-strong bg-sheet px-1.5 py-1 text-ink"
            >
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - limit))}
          className="rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 enabled:hover:bg-accent-soft disabled:text-faint"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={end >= total}
          onClick={() => onPage(offset + limit)}
          className="rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 enabled:hover:bg-accent-soft disabled:text-faint"
        >
          Next
        </button>
      </div>
    </div>
  );
}
