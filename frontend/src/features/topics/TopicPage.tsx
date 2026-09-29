import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import EntityLink from "../../components/EntityLink";
import NotFound from "../../app/NotFound";
import { ApiError } from "../../api/client";
import { topicDetail, type TopicDetail } from "../../api/topics";
import { formatCount } from "../../lib/format";
import TopicTrendPanel from "../trends/TopicTrendPanel";

export default function TopicPage() {
  const { id } = useParams();
  const topicId = Number(id);
  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!Number.isFinite(topicId)) return;
    const ctl = new AbortController();
    setDetail(null);
    setError(null);
    topicDetail(topicId, ctl.signal)
      .then(setDetail)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e);
      });
    return () => ctl.abort();
  }, [topicId]);

  if (!Number.isFinite(topicId)) return <NotFound message="That isn't a valid topic." />;
  if (error && error.kind === "http" && error.status === 404) return <NotFound message="This topic could not be found." />;
  if (error) return <p role="alert" className="py-10 text-warn">Could not load this topic ({error.message}).</p>;
  if (!detail) return <p className="py-10 text-sm text-muted">Loading topic\u2026</p>;

  return (
    <article className="max-w-4xl pb-16">
      {detail.parent && (
        <p className="mb-2 text-sm">
          <EntityLink kind="topic" id={detail.parent.topic_id}>
            {detail.parent.topic_name}
          </EntityLink>{" "}
          <span className="text-muted">/</span>
        </p>
      )}
      <h1 className="font-serif text-[28px] font-semibold leading-tight">{detail.topic_name}</h1>
      <p className="mt-2 text-base text-muted">{formatCount(detail.paper_count)} papers, including subtopics</p>
      {detail.description && <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed">{detail.description}</p>}

      <p className="mt-4">
        <Link to={`/papers?topic=${detail.topic_id}&topicName=${encodeURIComponent(detail.topic_name)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          View all papers on {detail.topic_name}
        </Link>
      </p>
      <p className="mt-1 text-sm">
        <Link to={`/explore?q=${encodeURIComponent(detail.topic_name)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          Explore {detail.topic_name} (authors, institutions, venues)
        </Link>
      </p>

      <section className="mt-8" aria-labelledby="topic-over-time">
        <h2 id="topic-over-time" className="font-serif text-xl font-semibold">
          Topic over time
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted">
          How many papers carry this topic each year, and whether the change on the year before clears the emerging or declining rule.
        </p>
        <div className="mt-3">
          <TopicTrendPanel topicId={detail.topic_id} />
        </div>
      </section>

      {detail.children.length > 0 && (
        <section className="mt-6">
          <h2 className="font-serif text-lg font-semibold">Subtopics</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.children.map((c) => (
              <li key={c.topic_id} className="flex items-baseline justify-between gap-3">
                <EntityLink kind="topic" id={c.topic_id}>
                  {c.topic_name}
                </EntityLink>
                <span className="text-muted">{formatCount(c.paper_count)} papers</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
