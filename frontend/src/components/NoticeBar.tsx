import type { ReactNode } from "react";

export type NoticeKind = "degraded" | "info" | "stale";

interface Props {
  kind: NoticeKind;
  children: ReactNode;
}

const STYLE: Record<NoticeKind, string> = {
  degraded: "border-warn/40 bg-warn-soft text-warn",
  stale: "border-warn/40 bg-warn-soft text-warn",
  info: "border-rule-strong bg-sheet text-ink",
};

/** role="status" banner for degraded-data, not-computed and stale-run
 * conditions (design-system.md §4). Never used for hard errors — those are
 * role="alert" and live inline where the failure happened. */
export default function NoticeBar({ kind, children }: Props) {
  return (
    <p role="status" className={`mb-4 rounded border px-4 py-2 text-sm ${STYLE[kind]}`}>
      {children}
    </p>
  );
}
