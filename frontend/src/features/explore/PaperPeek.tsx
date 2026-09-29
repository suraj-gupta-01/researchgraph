import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Drawer from "../../components/Drawer";
import EntityLink from "../../components/EntityLink";
import { paperDetail, type PaperDetail } from "../../api/papers";
import { ApiError } from "../../api/client";

interface Props {
  paperId: number | null;
  onClose: () => void;
  onKeyword: (kw: string) => void;
}

/** The right-side entity-peek drawer (design-system.md §3): a compact
 * summary that keeps the reader's place in the result list, with an
 * "Open full page" link to the paper page (provenance, citation chain,
 * full cites/cited-by lists). Author and institution names are real
 * EntityLinks to their own pages — filtering Explore by an author is a
 * separate action, already offered by the authors facet, so a name here
 * does the one thing every other author name in the app does: navigate. */
export default function PaperPeek({ paperId, onClose, onKeyword }: Props) {
  const [detail, setDetail] = useState<PaperDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (paperId === null) return;
    const ctl = new AbortController();
    setDetail(null);
    setError(null);
    paperDetail(paperId, ctl.signal)
      .then(setDetail)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [paperId]);

  return (
    <Drawer open={paperId !== null} onClose={onClose} title={detail ? detail.title : "Paper details"}>
      {error && <p className="text-sm text-warn">{error.kind === "http" && error.status === 404 ? "This paper could not be found." : "Could not load this paper."}</p>}
      {!detail && !error && <p className="text-sm text-muted">Loading paper\u2026</p>}
      {detail && (
        <article>
          <h2 className="font-serif text-xl font-semibold leading-snug">{detail.title}</h2>
          <p className="mt-1.5 text-sm text-muted">
            {detail.venue ? `${detail.venue.venue_name}, ` : ""}
            {detail.publication_year}. Cited {detail.citation_count.toLocaleString()} {detail.citation_count === 1 ? "time" : "times"}.
          </p>

          <p className="mt-3 text-sm">
            {detail.authors.slice(0, 5).map((a, i) => (
              <span key={a.author_id}>
                {i > 0 && ", "}
                <EntityLink kind="author" id={a.author_id}>
                  {a.full_name}
                </EntityLink>
              </span>
            ))}
            {detail.authors.length > 5 && ` and ${detail.authors.length - 5} more`}
          </p>

          {detail.abstract ? (
            <p className="mt-3 line-clamp-6 text-sm leading-relaxed">{detail.abstract}</p>
          ) : (
            <p className="mt-3 text-sm text-muted">{detail.text_status === "unavailable" ? "The abstract store is unreachable right now." : "No abstract was provided by the sources."}</p>
          )}

          {detail.keywords.length > 0 && (
            <p className="mt-3 flex flex-wrap gap-1.5">
              {detail.keywords.slice(0, 8).map((k) => (
                <button key={k} type="button" onClick={() => onKeyword(k)} className="border border-rule-strong bg-sheet px-2.5 py-0.5 text-xs hover:bg-accent-soft">
                  {k}
                </button>
              ))}
            </p>
          )}

          <p className="mt-5">
            <Link to={`/papers/${detail.paper_id}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
              Open full page
            </Link>
          </p>

          {detail.authors.some((a) => a.institutions.length > 0) && (
            <p className="mt-4 text-xs text-muted">
              {detail.authors
                .flatMap((a) => a.institutions)
                .slice(0, 3)
                .map((i, idx) => (
                  <span key={i.institution_id}>
                    {idx > 0 && "; "}
                    <EntityLink kind="institution" id={i.institution_id}>
                      {i.name}
                    </EntityLink>
                  </span>
                ))}
            </p>
          )}
        </article>
      )}
    </Drawer>
  );
}
