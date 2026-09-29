import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import Pagination from "../../components/Pagination";
import EntityLink from "../../components/EntityLink";
import { listTopics, type TopicSummary } from "../../api/topics";
import { getNum, getRef, getStr, setNum, setRef, setStr } from "../../lib/urlState";
import { ApiError } from "../../api/client";
import { formatCount } from "../../lib/format";

const PAGE_SIZE = 25;

export default function TopicsDirectory() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = getStr(params, "q") ?? "";
  const parent = getRef(params, "parent", "parentName");
  const offset = getNum(params, "offset") ?? 0;

  const [qDraft, setQDraft] = useState(q);
  const [data, setData] = useState<{ items: TopicSummary[]; total: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => setQDraft(q), [q]);

  const key = JSON.stringify({ q, parent, offset });
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    listTopics(q || undefined, parent?.id, offset, PAGE_SIZE, ctl.signal)
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

  const columns: Column<TopicSummary>[] = [
    {
      key: "name",
      label: "Topic",
      render: (t) => (
        <EntityLink kind="topic" id={t.topic_id}>
          {t.topic_name}
        </EntityLink>
      ),
    },
    {
      key: "children",
      label: "",
      render: (t) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            patch((p) => setRef(p, "parent", "parentName", { id: t.topic_id, name: t.topic_name }));
          }}
          className="text-sm text-accent underline decoration-1 underline-offset-2 hover:decoration-2"
        >
          Show subtopics
        </button>
      ),
    },
    { key: "papers", label: "Papers", align: "right", render: (t) => formatCount(t.paper_count) },
  ];

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Topics</h1>
      <p className="mt-1 text-sm text-muted">{data ? `${data.total.toLocaleString()} topics` : "Loading\u2026"}</p>

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
        <button type="submit" className="rounded-sm bg-accent px-4 py-1.5 font-medium text-white hover:bg-ink">
          Apply
        </button>
      </form>

      {parent && (
        <p className="mt-3 text-sm">
          <span className="inline-flex items-center gap-1.5 bg-accent-soft py-0.5 pl-3 pr-1">
            Subtopics of: {parent.name}
            <button type="button" onClick={() => patch((p) => setRef(p, "parent", "parentName", undefined))} aria-label="Remove parent filter" className="px-2 py-0.5 hover:bg-accent hover:text-white">
              &times;
            </button>
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          Could not load topics ({error.message}).
        </p>
      )}

      {data && (
        <div className="mt-4">
          <DataTable columns={columns} rows={data.items} rowKey={(t) => t.topic_id} onRowActivate={(t) => navigate(`/topics/${t.topic_id}`)} />
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
