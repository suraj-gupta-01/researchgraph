import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DataTable, { type Column } from "../../components/DataTable";
import EntityLink from "../../components/EntityLink";
import NoticeBar from "../../components/NoticeBar";
import NotFound from "../../app/NotFound";
import Pagination from "../../components/Pagination";
import { ApiError } from "../../api/client";
import { communityDetail, communityMembers, type CommunityDetail, type CommunityMemberOut } from "../../api/communities";
import { formatCount, formatDate, formatSharePercent, formatYearRange } from "../../lib/format";

const MEMBERS_PAGE_SIZE = 25;

function ScoreCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted">&mdash;</span>;
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-14 bg-rule" aria-hidden="true">
        <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular-nums text-muted">{formatSharePercent(value)}</span>
    </span>
  );
}

export default function CommunityPage() {
  const { id } = useParams();
  const communityId = Number(id);

  const [detail, setDetail] = useState<CommunityDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [members, setMembers] = useState<{ items: CommunityMemberOut[]; total: number } | null>(null);
  const [membersError, setMembersError] = useState<ApiError | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!Number.isFinite(communityId)) return;
    const ctl = new AbortController();
    setDetail(null);
    setError(null);
    // top_members: 0 — the header doesn't need a ranked list; the members
    // table below is its own paginated fetch (/communities/{id}/members).
    communityDetail(communityId, 0, ctl.signal)
      .then(setDetail)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [communityId]);

  useEffect(() => {
    if (!Number.isFinite(communityId) || error) return;
    const ctl = new AbortController();
    setMembers(null);
    setMembersError(null);
    communityMembers(communityId, offset, MEMBERS_PAGE_SIZE, ctl.signal)
      .then(setMembers)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setMembersError(e as ApiError);
      });
    return () => ctl.abort();
  }, [communityId, offset, error]);

  if (!Number.isFinite(communityId)) return <NotFound message="That isn't a valid community." />;
  if (error && error.kind === "http" && error.status === 404) {
    // Community_IDs churn on every graph.communities re-run (M4 Part 1's
    // replace semantics) — a 404 here almost always means the run this link
    // pointed to has since been superseded, not a typo.
    return (
      <div className="max-w-xl py-10">
        <h1 className="font-serif text-2xl font-semibold">This community was replaced by a newer run</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Community detection re-assigns new IDs each time <code className="font-mono text-[13px]">python -m graph.communities</code> runs, so a link to an old community stops resolving once it runs again.
        </p>
        <p className="mt-4 text-sm">
          <Link to="/communities" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
            Browse the current communities
          </Link>
        </p>
      </div>
    );
  }
  if (error) return <p role="alert" className="py-10 text-warn">Could not load this community ({error.message}).</p>;
  if (!detail) return <p className="py-10 text-sm text-muted">Loading community&hellip;</p>;

  const columns: Column<CommunityMemberOut>[] = [
    {
      key: "name",
      label: "Member",
      render: (m) => (
        <EntityLink kind="author" id={m.author_id}>
          {m.full_name}
        </EntityLink>
      ),
    },
    { key: "papers", label: "Papers", align: "right", render: (m) => formatCount(m.paper_count) },
    { key: "membership", label: "Membership score", render: (m) => <ScoreCell value={m.membership_score} /> },
  ];

  const topicColumns: Column<CommunityDetail["topics"][number]>[] = [
    { key: "topic", label: "Topic", render: (t) => <EntityLink kind="topic" id={t.topic_id}>{t.topic_name}</EntityLink> },
    { key: "share", label: "Share of this community's papers", align: "right", render: (t) => formatSharePercent(t.share) },
    { key: "corpus_share", label: "Share of all papers", align: "right", render: (t) => formatSharePercent(t.corpus_share) },
    { key: "score", label: "Label score", align: "right", render: (t) => t.score.toFixed(3) },
  ];

  const yearRange = formatYearRange(detail.year_min, detail.year_max);

  return (
    <article className="max-w-4xl pb-16">
      <p className="text-sm">
        <Link to="/communities" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          &larr; All communities
        </Link>
      </p>
      <h1 className="mt-2 font-serif text-[28px] font-semibold leading-tight">{detail.label ?? `Community ${detail.community_id}`}</h1>
      <p className="mt-2 max-w-[62ch] text-base text-muted">
        {formatCount(detail.member_count)} members &middot; {formatCount(detail.paper_count)} papers{yearRange ? ` \u00b7 ${yearRange}` : ""}
        {detail.root_topic_id !== null && detail.root_topic_name && (
          <>
            {" "}
            &middot; centered on{" "}
            <EntityLink kind="topic" id={detail.root_topic_id}>
              {detail.root_topic_name}
            </EntityLink>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-muted">
        Detected {formatDate(detail.detection_date)} &middot; <code className="font-mono text-[11px]">{detail.algorithm}</code>
      </p>
      <p className="mt-3 text-sm">
        <Link to={detail.root_topic_name ? `/communities/graph?q=${encodeURIComponent(detail.root_topic_name)}` : "/communities/graph"} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          View this community in the collaboration graph
        </Link>
      </p>

      {detail.top_institutions.length > 0 && (
        <section className="mt-8">
          <h2 className="font-serif text-lg font-semibold">Top institutions</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.top_institutions.map((inst) => (
              <li key={inst.institution_id} className="flex items-baseline justify-between gap-3">
                <EntityLink kind="institution" id={inst.institution_id}>
                  {inst.name}
                </EntityLink>
                <span className="text-muted">
                  {formatCount(inst.member_count)} {inst.member_count === 1 ? "member" : "members"}
                  {inst.country ? ` \u00b7 ${inst.country}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="font-serif text-lg font-semibold">Why this label</h2>
        {detail.topics_status === "unavailable" && (
          <NoticeBar kind="degraded">Label evidence is unavailable because MongoDB is down. The label and members above are still authoritative (they come from Postgres).</NoticeBar>
        )}
        {detail.topics_status === "stale" && (
          <NoticeBar kind="stale">This label evidence is from a previous detection run, not the one that produced the community shown here.</NoticeBar>
        )}
        {detail.topics_status === "missing" && <p className="mt-2 text-sm text-muted">No label evidence was stored for this run.</p>}
        {detail.topics.length > 0 ? (
          <>
            <p className="mt-1 max-w-[62ch] text-sm text-muted">
              The topics this community publishes on disproportionately more than the corpus as a whole &mdash; share within the community, divided by how common the topic is overall.
            </p>
            <div className="mt-2">
              <DataTable columns={topicColumns} rows={detail.topics} rowKey={(t) => t.topic_id} caption={`Label evidence for ${detail.label ?? `Community ${detail.community_id}`}`} />
            </div>
          </>
        ) : (
          detail.topics_status === "ok" && <p className="mt-2 text-sm text-muted">No scored topics for this community.</p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-lg font-semibold">Members</h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted">Membership score is the share of a member&rsquo;s tie weight that stays inside this community, rather than reaching out to others.</p>
        {membersError ? (
          <p role="alert" className="mt-3 text-sm text-warn">Could not load members ({membersError.message}).</p>
        ) : !members ? (
          <div aria-busy="true" className="mt-3 border border-rule">
            <p className="sr-only">Loading members</p>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="h-[34px] border-b border-rule bg-rule/30 last:border-b-0" />
            ))}
          </div>
        ) : (
          <div className="mt-3">
            <DataTable columns={columns} rows={members.items} rowKey={(m) => m.author_id} caption={`Members of ${detail.label ?? `Community ${detail.community_id}`}, most-published first`} />
            <Pagination offset={offset} limit={MEMBERS_PAGE_SIZE} total={members.total} onPage={setOffset} />
          </div>
        )}
      </section>
    </article>
  );
}
