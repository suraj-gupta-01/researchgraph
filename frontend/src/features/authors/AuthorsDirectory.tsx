import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import Pagination from "../../components/Pagination";
import EntityLink from "../../components/EntityLink";
import { listAuthors, type AuthorSort, type AuthorSummary } from "../../api/authors";
import { getNum, getRef, getStr, setNum, setRef, setStr } from "../../lib/urlState";
import { ApiError } from "../../api/client";
import { formatCount } from "../../lib/format";

const PAGE_SIZE = 25;

export default function AuthorsDirectory() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = getStr(params, "q") ?? "";
  const institution = getRef(params, "inst", "instName");
  const sort = (params.get("sort") as AuthorSort) ?? "citations";
  const offset = getNum(params, "offset") ?? 0;

  const [qDraft, setQDraft] = useState(q);
  const [data, setData] = useState<{ items: AuthorSummary[]; total: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => setQDraft(q), [q]);

  const key = JSON.stringify({ q, institution, sort, offset });
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    listAuthors(q || undefined, institution?.id, sort, offset, PAGE_SIZE, ctl.signal)
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

  const columns: Column<AuthorSummary>[] = [
    {
      key: "name",
      label: "Author",
      sortable: true,
      render: (a) => (
        <EntityLink kind="author" id={a.author_id}>
          {a.full_name}
        </EntityLink>
      ),
    },
    { key: "papers", label: "Papers", align: "right", sortable: true, render: (a) => formatCount(a.paper_count) },
    { key: "citations", label: "Citations", align: "right", sortable: true, render: (a) => formatCount(a.total_citations) },
  ];

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Authors</h1>
      <p className="mt-1 text-sm text-muted">{data ? `${data.total.toLocaleString()} authors` : "Loading\u2026"}</p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          patch((p) => setStr(p, "q", qDraft));
        }}
      >
        <label className="flex flex-col text-sm">
          Name contains
          <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} className="mt-1 w-56 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5" placeholder="e.g. Lee" />
        </label>
        <button type="submit" className="rounded-sm bg-accent px-4 py-1.5 font-medium text-white hover:bg-ink">
          Apply
        </button>
      </form>

      {institution && (
        <p className="mt-3 text-sm">
          <span className="inline-flex items-center gap-1.5 bg-accent-soft py-0.5 pl-3 pr-1">
            Institution: {institution.name}
            <button type="button" onClick={() => patch((p) => setRef(p, "inst", "instName", undefined))} aria-label="Remove institution filter" className="px-2 py-0.5 hover:bg-accent hover:text-white">
              &times;
            </button>
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          Could not load authors ({error.message}).
        </p>
      )}

      {data && (
        <div className="mt-4">
          <DataTable
            columns={columns}
            rows={data.items}
            rowKey={(a) => a.author_id}
            sort={sort === "name" ? "name" : sort}
            sortDesc={sort !== "name"}
            onSort={(k) => patch((p) => p.set("sort", k))}
            onRowActivate={(a) => navigate(`/authors/${a.author_id}`)}
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
