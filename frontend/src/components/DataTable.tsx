import { useRef, type KeyboardEvent, type ReactNode } from "react";
import ScrollRegion from "./ScrollRegion";

export interface Column<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  sortable?: boolean;
  render: (row: T) => ReactNode;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  sort?: string;
  sortDesc?: boolean;
  onSort?: (key: string) => void;
  onRowActivate?: (row: T) => void;
  caption?: string;
}

/** Server-side-sorted, dense table. Sorting is always a request to the
 * server (api-coverage.md §1: "Never sort a page client-side: it lies
 * about the ranking") — `onSort` is expected to trigger a refetch, not a
 * local re-order. Rows are arrow-key navigable and Enter-activatable when
 * `onRowActivate` is given. */
export default function DataTable<T>({ columns, rows, rowKey, sort, sortDesc, onSort, onRowActivate, caption }: Props<T>) {
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, i: number, row: T) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      rowRefs.current[i + 1]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      rowRefs.current[i - 1]?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && onRowActivate) {
      e.preventDefault();
      onRowActivate(row);
    }
  };

  return (
    <ScrollRegion label={caption ?? "Table"} className="border border-rule">
      <table className="w-full min-w-[480px] border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="sticky top-0 z-10 bg-sheet">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={c.sortable && onSort ? (sort === c.key ? (sortDesc ? "descending" : "ascending") : "none") : undefined}
                className={`border-b border-rule px-3 py-2 font-semibold ${c.align === "right" ? "text-right" : "text-left"}`}
              >
                {c.sortable && onSort ? (
                  <button
                    type="button"
                    onClick={() => onSort(c.key)}
                    className="inline-flex items-center gap-1 hover:text-accent"
                  >
                    {c.label}
                    {sort === c.key && <span aria-hidden="true">{sortDesc ? "\u2193" : "\u2191"}</span>}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row)}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              tabIndex={onRowActivate ? 0 : undefined}
              onKeyDown={onRowActivate ? (e) => onKeyDown(e, i, row) : undefined}
              onClick={onRowActivate ? () => onRowActivate(row) : undefined}
              className={`border-b border-rule last:border-b-0 ${onRowActivate ? "cursor-pointer hover:bg-accent-soft" : ""}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-2 align-top ${c.align === "right" ? "text-right tabular-nums" : ""}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-4 text-center text-muted">
                No rows.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
