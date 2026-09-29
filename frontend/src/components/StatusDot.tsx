import { useEffect, useState } from "react";
import { health, type Health } from "../api/meta";
import { ApiError } from "../api/client";

type Status = "ok" | "degraded" | "down" | "checking";

function summarize(h: Health | null, err: ApiError | null): Status {
  if (err) return err.status === 503 ? "degraded" : "down";
  if (!h) return "checking";
  return h.postgres === "ok" && h.mongo === "ok" ? "ok" : "degraded";
}

const COLOR: Record<Status, string> = {
  ok: "bg-trend-converging",
  degraded: "bg-warn",
  down: "bg-trend-emerging",
  checking: "bg-faint",
};

/** Top-bar data-source indicator. Polls /health and reports Postgres and
 * MongoDB status in a tooltip; a 503 still carries the per-store detail
 * (main.py raises HTTPException(503, status)), which this reads rather
 * than treating as an opaque failure. */
export default function StatusDot() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    let cancelled = false;
    const check = () =>
      health(ctl.signal)
        .then((r) => {
          if (!cancelled) {
            setH(r);
            setErr(null);
          }
        })
        .catch((e) => {
          if (cancelled || (e as Error).name === "AbortError") return;
          if (e instanceof ApiError && e.status === 503 && e.detail && typeof e.detail === "object" && "detail" in e.detail) {
            setH((e.detail as { detail: Health }).detail);
          } else {
            setH(null);
          }
          setErr(e instanceof ApiError ? e : new ApiError(String(e), "network"));
        });
    check();
    const id = window.setInterval(check, 30_000);
    return () => {
      cancelled = true;
      ctl.abort();
      window.clearInterval(id);
    };
  }, []);

  const status = summarize(h, err);
  const title = h ? `Postgres: ${h.postgres} \u2022 MongoDB: ${h.mongo}` : "Checking data sources\u2026";

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" title={title}>
      <span className={`h-2 w-2 rounded-full ${COLOR[status]}`} aria-hidden="true" />
      <span className="sr-only">Data sources: </span>
      {status === "ok" ? "stores ok" : status === "checking" ? "checking\u2026" : "stores degraded"}
    </span>
  );
}
