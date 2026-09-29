import { Link } from "react-router-dom";
import { formatDate } from "../lib/format";

interface Props {
  algorithm: string | null;
  /** Shown in place of the algorithm string when `algorithm` is null but the
   * analysis did run and the endpoint just doesn't report the string
   * (/topics/converging, api-coverage.md G4). Without it a null algorithm
   * reads "not run yet", which would be false here. */
  algorithmNote?: string;
  detectionDate?: string | null;
  explanation: string;
  linkToMethods?: boolean;
}

/** <details> disclosure attached to every analytic figure: algorithm string
 * (with parameters), run date, and one plain sentence. design-system.md §7:
 * codes and algorithm names belong only inside this, never in page prose. */
export default function Method({ algorithm, algorithmNote, detectionDate, explanation, linkToMethods = true }: Props) {
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-muted hover:text-ink">Method</summary>
      <dl className="mt-1.5 space-y-1 border-l-2 border-rule pl-3">
        <div>
          <dt className="inline text-muted">Algorithm: </dt>
          {algorithm === null && algorithmNote ? (
            <dd className="inline">{algorithmNote}</dd>
          ) : (
            <dd className="inline font-mono text-[13px]">{algorithm ?? "not run yet"}</dd>
          )}
        </div>
        {detectionDate && (
          <div>
            <dt className="inline text-muted">Run date: </dt>
            <dd className="inline">{formatDate(detectionDate)}</dd>
          </div>
        )}
        <p className="text-muted">{explanation}</p>
        {linkToMethods && (
          <p>
            <Link to="/methods" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
              Methods &amp; runs
            </Link>
          </p>
        )}
      </dl>
    </details>
  );
}
