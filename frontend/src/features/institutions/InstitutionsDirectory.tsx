import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import Pagination from "../../components/Pagination";
import EntityLink from "../../components/EntityLink";
import { listInstitutions, type InstitutionSort, type InstitutionSummary } from "../../api/institutions";
import { getNum, getStr, setNum, setStr } from "../../lib/urlState";
import { ApiError } from "../../api/client";
import { formatCount } from "../../lib/format";

const PAGE_SIZE = 25;

export default function InstitutionsDirectory() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = getStr(params, "q") ?? "";
  const country = getStr(params, "country") ?? "";
  const sort = (params.get("sort") as InstitutionSort) ?? "papers";
  const offset = getNum(params, "offset") ?? 0;

  const [qDraft, setQDraft] = useState(q);
  const [countryDraft, setCountryDraft] = useState(country);
  const [data, setData] = useState<{ items: InstitutionSummary[]; total: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setQDraft(q);
    setCountryDraft(country);
  }, [q, country]);

  const key = JSON.stringify({ q, country, sort, offset });
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    listInstitutions(q || undefined, country || undefined, sort, offset, PAGE_SIZE, ctl.signal)
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

  const columns: Column<InstitutionSummary>[] = [
    {
      key: "name",
      label: "Institution",
      sortable: true,
      render: (i) => (
        <EntityLink kind="institution" id={i.institution_id}>
          {i.name}
        </EntityLink>
      ),
    },
    { key: "country", label: "Country", render: (i) => <span className="text-muted">{i.country ?? "\u2014"}</span> },
    { key: "authors", label: "Authors", align: "right", sortable: true, render: (i) => formatCount(i.author_count) },
    { key: "papers", label: "Papers", align: "right", sortable: true, render: (i) => formatCount(i.paper_count) },
  ];

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Institutions</h1>
      <p className="mt-1 text-sm text-muted">{data ? `${data.total.toLocaleString()} institutions` : "Loading\u2026"}</p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          patch((p) => {
            setStr(p, "q", qDraft);
            setStr(p, "country", countryDraft);
          });
        }}
      >
        <label className="flex flex-col text-sm">
          Name contains
          <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} className="mt-1 w-56 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5" />
        </label>
        <label className="flex flex-col text-sm">
          Country
          <input value={countryDraft} onChange={(e) => setCountryDraft(e.target.value)} className="mt-1 w-40 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5" placeholder="e.g. Canada" />
        </label>
        <button type="submit" className="rounded-sm bg-accent px-4 py-1.5 font-medium text-white hover:bg-ink">
          Apply
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          Could not load institutions ({error.message}).
        </p>
      )}

      {data && (
        <div className="mt-4">
          <DataTable
            columns={columns}
            rows={data.items}
            rowKey={(i) => i.institution_id}
            sort={sort === "name" ? "name" : sort}
            sortDesc={sort !== "name"}
            onSort={(k) => patch((p) => p.set("sort", k))}
            onRowActivate={(i) => navigate(`/institutions/${i.institution_id}`)}
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
