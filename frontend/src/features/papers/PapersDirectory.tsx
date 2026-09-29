import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import Pagination from "../../components/Pagination";
import EntityLink from "../../components/EntityLink";
import { listPapers, type PaperListSort, type PaperSummary } from "../../api/papers";
import { getNum, getRef, getStr, setNum, setRef, setStr } from "../../lib/urlState";
import { ApiError } from "../../api/client";
import { formatCount } from "../../lib/format";

const PAGE_SIZE = 25;

export default function PapersDirectory() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = getStr(params, "q") ?? "";
  const yearFrom = getNum(params, "from");
  const yearTo = getNum(params, "to");
  const venue = getRef(params, "venue", "venueName");
  const author = getRef(params, "author", "authorName");
  const institution = getRef(params, "inst", "instName");
  const topic = getRef(params, "topic", "topicName");
  const sort = (params.get("sort") as PaperListSort) ?? "citations";
  const offset = getNum(params, "offset") ?? 0;

  const [qDraft, setQDraft] = useState(q);
  const [data, setData] = useState<{ items: PaperSummary[]; total: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => setQDraft(q), [q]);

  const key = JSON.stringify({ q, yearFrom, yearTo, venue, author, institution, topic, sort, offset });
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    listPapers(
      { q: q || undefined, yearFrom, yearTo, venueId: venue?.id, authorId: author?.id, institutionId: institution?.id, topicId: topic?.id },
      sort,
      offset,
      PAGE_SIZE,
      ctl.signal,
    )
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
  const removeFilter = (idKey: string, nameKey: string) => patch((p) => setRef(p, idKey, nameKey, undefined));

  const columns: Column<PaperSummary>[] = [
    {
      key: "title",
      label: "Title",
      sortable: false,
      render: (p) => (
        <EntityLink kind="paper" id={p.paper_id}>
          {p.title}
        </EntityLink>
      ),
    },
    { key: "authors", label: "Authors", render: (p) => <span className="text-muted">{p.authors.slice(0, 2).join(", ")}{p.author_count > 2 ? ` +${p.author_count - 2}` : ""}</span> },
    { key: "venue", label: "Venue", render: (p) => <span className="text-muted">{p.venue_name ?? "\u2014"}</span> },
    { key: "year", label: "Year", align: "right", sortable: true, render: (p) => p.publication_year },
    { key: "citations", label: "Citations", align: "right", sortable: true, render: (p) => formatCount(p.citation_count) },
  ];

  const hasEntityFilter = venue || author || institution || topic;

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Papers</h1>
      <p className="mt-1 text-sm text-muted">{data ? `${data.total.toLocaleString()} papers` : "Loading\u2026"}</p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          patch((p) => setStr(p, "q", qDraft));
        }}
      >
        <label className="flex flex-col text-sm">
          Title contains
          <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} className="mt-1 w-56 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5" placeholder="e.g. federated" />
        </label>
        <label className="flex flex-col text-sm">
          From year
          <input
            type="number"
            value={yearFrom ?? ""}
            onChange={(e) => patch((p) => setNum(p, "from", e.target.value ? Number(e.target.value) : undefined))}
            className="mt-1 w-24 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          To year
          <input
            type="number"
            value={yearTo ?? ""}
            onChange={(e) => patch((p) => setNum(p, "to", e.target.value ? Number(e.target.value) : undefined))}
            className="mt-1 w-24 rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5"
          />
        </label>
        <button type="submit" className="rounded-sm bg-accent px-4 py-1.5 font-medium text-white hover:bg-ink">
          Apply
        </button>
      </form>

      {hasEntityFilter && (
        <p className="mt-3 flex flex-wrap gap-2 text-sm">
          {venue && <Chip label={`Venue: ${venue.name}`} onRemove={() => removeFilter("venue", "venueName")} />}
          {author && <Chip label={`Author: ${author.name}`} onRemove={() => removeFilter("author", "authorName")} />}
          {institution && <Chip label={`Institution: ${institution.name}`} onRemove={() => removeFilter("inst", "instName")} />}
          {topic && <Chip label={`Topic: ${topic.name} (includes subtopics)`} onRemove={() => removeFilter("topic", "topicName")} />}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          Could not load papers ({error.message}).
        </p>
      )}

      {data && (
        <div className="mt-4">
          <DataTable
            columns={columns}
            rows={data.items}
            rowKey={(p) => p.paper_id}
            sort={sort}
            sortDesc={sort !== "title"}
            onSort={(k) => patch((p) => p.set("sort", k))}
            onRowActivate={(p) => navigate(`/papers/${p.paper_id}`)}
          />
          <Pagination offset={offset} limit={PAGE_SIZE} total={data.total} onPage={(o) => setParams((prev) => { const n = new URLSearchParams(prev); setNum(n, "offset", o || undefined); return n; })} />
        </div>
      )}
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 bg-accent-soft py-0.5 pl-3 pr-1">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter: ${label}`} className="px-2 py-0.5 hover:bg-accent hover:text-white">
        &times;
      </button>
    </span>
  );
}
