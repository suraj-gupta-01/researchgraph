import type { ReactNode } from "react";

/** A link that leaves the dashboard: new tab, no referrer or opener, and
 * says so to screen readers. */
export default function ExternalLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`text-accent underline decoration-1 underline-offset-2 hover:decoration-2 ${className}`}>
      {children}
      <span aria-hidden="true"> ↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
