import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import EntityLink from "../../components/EntityLink";
import NotFound from "../../app/NotFound";
import PapersByYear from "../../components/PapersByYear";
import InfluencePanel from "./InfluencePanel";
import { ApiError } from "../../api/client";
import { authorDetail, type AuthorDetail } from "../../api/authors";
import { formatCount } from "../../lib/format";

export default function AuthorPage() {
  const { id } = useParams();
  const authorId = Number(id);
  const [detail, setDetail] = useState<AuthorDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!Number.isFinite(authorId)) return;
    const ctl = new AbortController();
    setDetail(null);
    setError(null);
    authorDetail(authorId, ctl.signal)
      .then(setDetail)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e);
      });
    return () => ctl.abort();
  }, [authorId]);

  if (!Number.isFinite(authorId)) return <NotFound message="That isn't a valid author." />;
  if (error && error.kind === "http" && error.status === 404) return <NotFound message="This author could not be found." />;
  if (error) return <p role="alert" className="py-10 text-warn">Could not load this author ({error.message}).</p>;
  if (!detail) return <p className="py-10 text-sm text-muted">Loading author\u2026</p>;


  return (
    <article className="max-w-3xl pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">{detail.full_name}</h1>
      <p className="mt-2 text-base text-muted">
        {formatCount(detail.paper_count)} papers &middot; cited {formatCount(detail.total_citations)} times
        {detail.orcid && (
          <>
            {" "}
            &middot;{" "}
            <a href={`https://orcid.org/${detail.orcid}`} target="_blank" rel="noreferrer" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
              ORCID {detail.orcid}
            </a>
          </>
        )}
      </p>
      <p className="mt-3">
        <Link to={`/papers?author=${detail.author_id}&authorName=${encodeURIComponent(detail.full_name)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          View all papers by {detail.full_name}
        </Link>
      </p>

      {detail.institutions.length > 0 && (
        <section className="mt-6">
          <h2 className="font-serif text-lg font-semibold">Affiliations</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.institutions.map((inst) => (
              <li key={inst.institution_id} className="flex items-baseline justify-between gap-3">
                <EntityLink kind="institution" id={inst.institution_id}>
                  {inst.name}
                </EntityLink>
                <span className="text-muted">
                  {inst.first_year && inst.last_year ? (inst.first_year === inst.last_year ? inst.first_year : `${inst.first_year}\u2013${inst.last_year}`) : ""}
                  {inst.country ? ` \u00b7 ${inst.country}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PapersByYear data={detail.papers_by_year} />

      {detail.coauthors.length > 0 && (
        <section className="mt-6">
          <h2 className="font-serif text-lg font-semibold">Frequent coauthors</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.coauthors.map((c) => (
              <li key={c.author_id} className="flex items-baseline justify-between gap-3">
                <EntityLink kind="author" id={c.author_id}>
                  {c.full_name}
                </EntityLink>
                <span className="text-muted">{c.shared_papers} shared {c.shared_papers === 1 ? "paper" : "papers"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="font-serif text-lg font-semibold">Influence and bridge score</h2>
        <div className="mt-2">
          <InfluencePanel authorId={detail.author_id} />
        </div>
      </section>
    </article>
  );
}
