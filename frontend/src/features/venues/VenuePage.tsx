import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import NotFound from "../../app/NotFound";
import PapersByYear from "../../components/PapersByYear";
import { ApiError } from "../../api/client";
import { venueDetail, type VenueDetail } from "../../api/venues";
import { formatCount } from "../../lib/format";

export default function VenuePage() {
  const { id } = useParams();
  const venueId = Number(id);
  const [detail, setDetail] = useState<VenueDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!Number.isFinite(venueId)) return;
    const ctl = new AbortController();
    setDetail(null);
    setError(null);
    venueDetail(venueId, ctl.signal)
      .then(setDetail)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e);
      });
    return () => ctl.abort();
  }, [venueId]);

  if (!Number.isFinite(venueId)) return <NotFound message="That isn't a valid venue." />;
  if (error && error.kind === "http" && error.status === 404) return <NotFound message="This venue could not be found." />;
  if (error) return <p role="alert" className="py-10 text-warn">Could not load this venue ({error.message}).</p>;
  if (!detail) return <p className="py-10 text-sm text-muted">Loading venue\u2026</p>;


  return (
    <article className="max-w-3xl pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">{detail.venue_name}</h1>
      <p className="mt-2 text-base capitalize text-muted">
        {[detail.venue_type, detail.publisher].filter(Boolean).join(" \u00b7 ")}
        {detail.venue_type || detail.publisher ? " \u00b7 " : ""}
        {formatCount(detail.paper_count)} papers
        {detail.issn && ` \u00b7 ISSN ${detail.issn}`}
      </p>
      <p className="mt-3">
        <Link to={`/papers?venue=${detail.venue_id}&venueName=${encodeURIComponent(detail.venue_name)}`} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
          View all papers in {detail.venue_name}
        </Link>
      </p>

      <PapersByYear data={detail.papers_by_year} />
    </article>
  );
}
