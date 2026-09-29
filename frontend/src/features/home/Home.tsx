import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import EntityLink from "../../components/EntityLink";
import TrendBadge from "../../components/TrendBadge";
import { ApiError } from "../../api/client";
import { listBridgeAuthors } from "../../api/authors";
import { listCommunities } from "../../api/communities";
import { metaRuns, type AnalysisRun } from "../../api/meta";
import { convergingTopics, trendingTopics } from "../../api/topics";
import { formatCount, formatDate, formatGrowthRate, formatScore } from "../../lib/format";

const DIGEST_ROWS = 5;

type Loaded<T> = { state: "loading" } | { state: "error"; error: ApiError } | { state: "ok"; data: T };

/** One request per digest, each with its own loading/error state, so one
 * slow or failing analysis never blanks the others. */
function useLoad<T>(load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const [v, setV] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal)
      .then((data) => setV({ state: "ok", data }))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setV({ state: "error", error: e as ApiError });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

/** / (Phase 8): the F6 dashboard's front page. Not a hero: a sentence
 * pointing at the topic scope, the corpus size, then one small digest per
 * analysis (F2 to F5), each linking to its full page. Every number comes
 * from the API; a digest whose job has not run says so and names it. */
export default function Home() {
  const runs = useLoad((s) => metaRuns(s));
  const emerging = useLoad((s) => trendingTopics("emerging", undefined, 0, DIGEST_ROWS, s));
  const converging = useLoad((s) => convergingTopics(undefined, 0, DIGEST_ROWS, s));
  const bridges = useLoad((s) => listBridgeAuthors(undefined, 2, 0, DIGEST_ROWS, s));
  const communities = useLoad((s) => listCommunities(undefined, 3, 0, DIGEST_ROWS, s));

  const runOf = (name: string): AnalysisRun | undefined => (runs.state === "ok" ? runs.data.runs.find((r) => r.analysis === name) : undefined);
  const nodeCounts = (runOf("graph")?.details?.full_graph as { node_counts?: Record<string, number> } | undefined)?.node_counts;

  return (
    <div className="pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">Research landscape</h1>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        Communities, rising topics, converging fields and the researchers who connect them, computed from the loaded corpus. Set a topic scope in the bar above to explore one field.
      </p>
      {nodeCounts && (
        <p className="mt-3 text-sm">
          {formatCount(nodeCounts.paper)} papers &middot; {formatCount(nodeCounts.author)} authors &middot; {formatCount(nodeCounts.institution)} institutions &middot; {formatCount(nodeCounts.venue)} venues &middot; {formatCount(nodeCounts.topic)} topics
          {runOf("graph")?.detected_at && <span className="text-muted"> &middot; graph built {formatDate(runOf("graph")!.detected_at!)}</span>}
        </p>
      )}

      <div className="mt-8 grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-2">
        <Digest
          title="Emerging topics"
          to="/trends"
          linkLabel="All emerging and declining topics"
          loaded={emerging}
          isEmpty={(d) => d.items.length === 0}
          notComputed={{ command: "python -m graph.trends" }}
          subtitle={(d) => (d.items[0] ? `${d.items[0].year}, at least +30% papers year over year` : "")}
          render={(d) => (
            <DigestTable head={["Topic", "Papers", "Growth"]}>
              {d.items.map((t) => (
                <tr key={t.topic_id} className="border-b border-rule last:border-b-0">
                  <td className="py-1.5 pr-3"><EntityLink kind="topic" id={t.topic_id}>{t.topic_name}</EntityLink></td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatCount(t.paper_count)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatGrowthRate(t.growth_rate)}</td>
                </tr>
              ))}
            </DigestTable>
          )}
        />

        <Digest
          title="Interdisciplinary connections"
          to="/connections"
          linkLabel="All converging topic pairs"
          loaded={converging}
          isEmpty={(d) => d.items.length === 0}
          notComputed={{ command: "python -m graph.convergence", after: "graph.trends" }}
          subtitle={(d) => (d.items[0] ? `${d.items[0].year}, topic pairs appearing together on more papers` : "")}
          render={(d) => (
            <DigestTable head={["Topic pair", "Papers", "Growth"]}>
              {d.items.map((p) => (
                <tr key={`${p.topic_a_id}-${p.topic_b_id}`} className="border-b border-rule last:border-b-0">
                  <td className="py-1.5 pr-3">
                    <EntityLink kind="topic" id={p.topic_a_id}>{p.topic_a_name}</EntityLink> + <EntityLink kind="topic" id={p.topic_b_id}>{p.topic_b_name}</EntityLink>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatCount(p.cooccurrence_count)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    <span className="inline-flex items-center gap-2">
                      {formatGrowthRate(p.growth_rate)} <TrendBadge label="Converging" />
                    </span>
                  </td>
                </tr>
              ))}
            </DigestTable>
          )}
        />

        <Digest
          title="Bridge researchers"
          to="/bridges"
          linkLabel="All bridge researchers"
          loaded={bridges}
          isEmpty={(d) => d.items.length === 0}
          notComputed={{ command: "python -m graph.influence", after: "graph.communities" }}
          subtitle={() => "Authors whose ties spread across two or more communities"}
          render={(d) => (
            <DigestTable head={["Researcher", "Communities", "Bridge score"]}>
              {d.items.map((a) => (
                <tr key={a.author_id} className="border-b border-rule last:border-b-0">
                  <td className="py-1.5 pr-3"><EntityLink kind="author" id={a.author_id}>{a.full_name}</EntityLink></td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{a.communities_touched}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatScore(a.bridge_score)}</td>
                </tr>
              ))}
            </DigestTable>
          )}
        />

        <Digest
          title="Largest communities"
          to="/communities"
          linkLabel="All communities and the community graph"
          loaded={communities}
          isEmpty={(d) => d.items.length === 0}
          notComputed={{ command: "python -m graph.communities", after: "topic extraction" }}
          subtitle={(d) => `${formatCount(d.total)} detected`}
          render={(d) => (
            <DigestTable head={["Community", "Members", "Papers"]}>
              {d.items.map((c) => (
                <tr key={c.community_id} className="border-b border-rule last:border-b-0">
                  <td className="py-1.5 pr-3">
                    <EntityLink kind="community" id={c.community_id}>{c.label ?? `Community ${c.community_id}`}</EntityLink>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatCount(c.member_count)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatCount(c.paper_count)}</td>
                </tr>
              ))}
            </DigestTable>
          )}
        />
      </div>

      <p className="mt-10 text-sm">
        Also:{" "}
        <Link to="/explore" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">Explore a topic</Link> &middot;{" "}
        <Link to="/institutions/top" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">Top institutions</Link> &middot;{" "}
        <Link to="/institutions/network" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">Institution network</Link> &middot;{" "}
        <Link to="/methods" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">Methods &amp; runs</Link>
      </p>
    </div>
  );
}

function Digest<T>({
  title,
  to,
  linkLabel,
  loaded,
  isEmpty,
  notComputed,
  subtitle,
  render,
}: {
  title: string;
  to: string;
  linkLabel: string;
  loaded: Loaded<T>;
  isEmpty: (d: T) => boolean;
  notComputed: { command: string; after?: string };
  subtitle: (d: T) => string;
  render: (d: T) => ReactNode;
}) {
  const id = `digest-${to.replace(/\W/g, "")}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="font-serif text-lg font-semibold">
        <Link to={to} className="hover:text-accent">{title}</Link>
      </h2>
      {loaded.state === "loading" && <p className="mt-2 text-sm text-muted">Loading&hellip;</p>}
      {loaded.state === "error" && <p role="alert" className="mt-2 text-sm text-warn">Could not load ({loaded.error.message}).</p>}
      {loaded.state === "ok" && isEmpty(loaded.data) && (
        <p className="mt-2 text-sm text-muted">
          Not computed yet. {notComputed.after ? <>After {notComputed.after}, run </> : <>Run </>}
          <code className="font-mono text-[13px]">{notComputed.command}</code>.
        </p>
      )}
      {loaded.state === "ok" && !isEmpty(loaded.data) && (
        <>
          <p className="text-sm text-muted">{subtitle(loaded.data)}</p>
          <div className="mt-2">{render(loaded.data)}</div>
          <p className="mt-2 text-sm">
            <Link to={to} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">{linkLabel} &rarr;</Link>
          </p>
        </>
      )}
    </section>
  );
}

function DigestTable({ head, children }: { head: [string, string, string]; children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-rule-strong">
          <th scope="col" className="py-1 pr-3 text-left font-semibold">{head[0]}</th>
          <th scope="col" className="py-1 pr-3 text-right font-semibold">{head[1]}</th>
          <th scope="col" className="py-1 text-right font-semibold">{head[2]}</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
