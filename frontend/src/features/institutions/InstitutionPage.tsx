import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import EntityLink from "../../components/EntityLink";
import NotFound from "../../app/NotFound";
import PapersByYear from "../../components/PapersByYear";
import { ApiError } from "../../api/client";
import { institutionDetail, type InstitutionDetail } from "../../api/institutions";
import { formatCount } from "../../lib/format";
import CollaboratorsPanel from "./CollaboratorsPanel";

export default function InstitutionPage() {
  const { id } = useParams();
  const institutionId = Number(id);
  const [detail, setDetail] = useState<InstitutionDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!Number.isFinite(institutionId)) return;
    const ctl = new AbortController();
    setDetail(null);
    setError(null);
    institutionDetail(institutionId, ctl.signal)
      .then(setDetail)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e);
      });
    return () => ctl.abort();
  }, [institutionId]);

  if (!Number.isFinite(institutionId)) return <NotFound message="That isn't a valid institution." />;
  if (error && error.kind === "http" && error.status === 404) return <NotFound message="This institution could not be found." />;
  if (error) return <p role="alert" className="py-10 text-warn">Could not load this institution ({error.message}).</p>;
  if (!detail) return <p className="py-10 text-sm text-muted">Loading institution\u2026</p>;


  return (
    <article className="max-w-3xl pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">{detail.name}</h1>
      <p className="mt-2 text-base text-muted">
        {formatCount(detail.paper_count)} papers &middot; {formatCount(detail.author_count)} authors
        {detail.country ? ` \u00b7 ${detail.country}` : ""}
        {detail.ror_id && (
          <>
            {" "}
            &middot;{" "}
            <a href={detail.ror_id} target="_blank" rel="noreferrer" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
              ROR
            </a>
          </>
        )}
      </p>
      <p className="mt-3 flex flex-wrap gap-x-4 text-sm">
        <Link to={`/papers?inst=${detail.institution_id}&instName=${encodeURIComponent(detail.name)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          View all papers
        </Link>
        <Link to={`/authors?inst=${detail.institution_id}&instName=${encodeURIComponent(detail.name)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          View all authors
        </Link>
      </p>

      <PapersByYear data={detail.papers_by_year} />

      {detail.top_authors.length > 0 && (
        <section className="mt-6">
          <h2 className="font-serif text-lg font-semibold">Most active authors</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.top_authors.map((a) => (
              <li key={a.author_id} className="flex items-baseline justify-between gap-3">
                <EntityLink kind="author" id={a.author_id}>
                  {a.full_name}
                </EntityLink>
                <span className="text-muted">{formatCount(a.paper_count)} papers</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <CollaboratorsPanel institutionId={detail.institution_id} name={detail.name} />
    </article>
  );
}
