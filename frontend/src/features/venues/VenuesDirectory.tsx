import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import Pagination from "../../components/Pagination";
import EntityLink from "../../components/EntityLink";
import { listVenues, type VenueSort, type VenueSummary } from "../../api/venues";
import { getNum, getStr, setNum, setStr } from "../../lib/urlState";
import { ApiError } from "../../api/client";
import { formatCount } from "../../lib/format";

const PAGE_SIZE = 25;

export default function VenuesDirectory() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = getStr(params, "q") ?? "";
  const venueType = getStr(params, "type") ?? "";
  const sort = (params.get("sort") as VenueSort) ?? "papers";
  const offset = getNum(params, "offset") ?? 0;

  const [qDraft, setQDraft] = useState(q);
  const [data, setData] = useState<{ items: VenueSummary[]; total: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => setQDraft(q), [q]);

  const key = JSON.stringify({ q, venueType, sort, offset });
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    listVenues(q || undefined, venueType || undefined, sort, offset, PAGE_SIZE, ctl.signal)
      .then((r) => setData({ items: r.items, total: r.total }))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const patch = (mutate: (p: URLSearchParams) => void) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      next.delete("offset");
      return next;
    });

  const columns: Column<VenueSummary>[] = [
    {
      key: "name",
      label: "Venue",
      sortable: true,
      render: (v) => (
        <EntityLink kind="venue" id={v.venue_id}>
          {v.venue_name}
        </EntityLink>
      ),
    },
    { key: "type", label: "Type", render: (v) => <span className="capitalize text-muted">{v.venue_type ?? "\u2014"}</span> },
    { key: "publisher", label: "Publisher", render: (v) => <span className="text-muted">{v.publisher ?? "\u2014"}</span> },
    { key: "papers", label: "Papers", align: "right", sortable: true, render: (v) => formatCount(v.paper_count) },
  ];

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Venues</h1>
      <p className="mt-1 text-sm text-muted">{data ? `${data.total.toLocaleString()} venues` : "Loading\u2026"}</p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          patch((p) => setStr(p, "q", qDraft));
        }}
      >
        <label className="flex flex-col text-sm">
          Name contains
          <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} className="mt-1 w-56 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5" />
        </label>
        <label className="flex flex-col text-sm">
          Type
          <select value={venueType} onChange={(e) => patch((p) => setStr(p, "type", e.target.value))} className="mt-1 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5">
            <option value="">Any</option>
            <option value="journal">Journal</option>
            <option value="conference">Conference</option>
            <option value="workshop">Workshop</option>
          </select>
        </label>
        <button type="submit" className="rounded-sm bg-accent px-4 py-1.5 font-medium text-white hover:bg-ink">
          Apply
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          Could not load venues ({error.message}).
        </p>
      )}

      {data && (
        <div className="mt-4">
          <DataTable
            columns={columns}
            rows={data.items}
            rowKey={(v) => v.venue_id}
            sort={sort === "name" ? "name" : sort}
            sortDesc={sort !== "name"}
            onSort={(k) => patch((p) => p.set("sort", k))}
            onRowActivate={(v) => navigate(`/venues/${v.venue_id}`)}
          />
          <Pagination
            offset={offset}
            limit={PAGE_SIZE}
            total={data.total}
            onPage={(o) =>
              setParams((prev) => {
                const n = new URLSearchParams(prev);
                setNum(n, "offset", o || undefined);
                return n;
              })
            }
          />
        </div>
      )}
    </div>
  );
}
