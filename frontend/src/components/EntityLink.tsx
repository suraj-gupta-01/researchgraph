import { Link } from "react-router-dom";
import type { ReactNode } from "react";

export type EntityKind = "paper" | "author" | "institution" | "venue" | "topic" | "community";

const ROUTE: Record<EntityKind, string> = {
  paper: "/papers",
  author: "/authors",
  institution: "/institutions",
  venue: "/venues",
  topic: "/topics",
  community: "/communities",
};

interface Props {
  kind: EntityKind;
  id: number;
  children: ReactNode;
  className?: string;
}

/** A typed link to any entity page. Papers render in serif (matching paper
 * titles everywhere else); people and institutions render in sans. */
export default function EntityLink({ kind, id, children, className }: Props) {
  const serif = kind === "paper";
  return (
    <Link
      to={`${ROUTE[kind]}/${id}`}
      className={`text-accent underline decoration-1 underline-offset-2 hover:decoration-2 ${serif ? "font-serif" : ""} ${className ?? ""}`}
    >
      {children}
    </Link>
  );
}
