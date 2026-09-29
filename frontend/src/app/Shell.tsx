import { type ReactNode, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import Typeahead from "../components/Typeahead";
import StatusDot from "../components/StatusDot";
import { useScope } from "./ScopeContext";
import { useAuth } from "./AuthContext";

interface NavItemDef {
  label: string;
  to?: string; // undefined = not built yet in this phase
  /** Active only on this exact path (the root would otherwise match every route). */
  end?: boolean;
}

const HOME: NavItemDef = { label: "Overview", to: "/", end: true };
const EXPLORE: NavItemDef = { label: "Explore", to: "/explore" };
const ANALYSIS: NavItemDef[] = [
  { label: "Communities", to: "/communities" },
  { label: "Trends", to: "/trends" },
  { label: "Bridge researchers", to: "/bridges" },
  { label: "Interdisciplinary connections", to: "/connections" },
  { label: "Institution network", to: "/institutions/network" },
  { label: "Top institutions", to: "/institutions/top" },
];
const DIRECTORIES: NavItemDef[] = [
  { label: "Papers", to: "/papers" },
  { label: "Authors", to: "/authors" },
  { label: "Institutions", to: "/institutions" },
  { label: "Venues", to: "/venues" },
  { label: "Topics", to: "/topics" },
];
const METHODS: NavItemDef = { label: "Methods & runs", to: "/methods" };
// Role-gated: hidden, not merely disabled, for roles that cannot use them
// (the API refuses them too -- app/main.py).
const QUERY_LAB: NavItemDef = { label: "Query lab", to: "/query-lab" };
const ACCOUNTS: NavItemDef = { label: "Accounts", to: "/accounts" };

function NavItem({ item }: { item: NavItemDef }) {
  if (!item.to) {
    return (
      <span aria-disabled="true" className="block px-2 py-1.5 text-sm text-faint" title="Not built yet in this phase">
        {item.label}
      </span>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => `block px-2 py-1.5 text-sm hover:bg-accent-soft ${isActive ? "bg-accent-soft font-medium text-accent" : "text-ink"}`}
    >
      {item.label}
    </NavLink>
  );
}

function RailContent() {
  const { can } = useAuth();
  return (
    <nav aria-label="Primary">
      <NavItem item={HOME} />
      <NavItem item={EXPLORE} />
      <p className="mt-3 px-2 text-xs font-medium text-faint">Analysis</p>
      {ANALYSIS.map((i) => (
        <NavItem key={i.label} item={i} />
      ))}
      <p className="mt-3 px-2 text-xs font-medium text-faint">Directories</p>
      {DIRECTORIES.map((i) => (
        <NavItem key={i.label} item={i} />
      ))}
      <div className="mt-3 border-t border-rule pt-3">
        <NavItem item={METHODS} />
        {can("analyst") && <NavItem item={QUERY_LAB} />}
        {can("admin") && <NavItem item={ACCOUNTS} />}
      </div>
    </nav>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const { scope, setScope, submitScope } = useScope();
  const [railOpen, setRailOpen] = useState(false);

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule bg-sheet">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5">
          <button
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            className="rounded-sm border border-rule-strong px-2 py-1 text-sm md:hidden"
            aria-expanded={railOpen}
            aria-controls="primary-rail"
          >
            Menu
          </button>
          <Link to="/" className="font-serif text-xl font-semibold tracking-tight text-ink">
            ResearchGraph
          </Link>
          <Typeahead id="topic-scope" label="Research topic scope" value={scope} onChange={setScope} onSubmit={submitScope} placeholder="Set a topic scope, for example federated learning" />
          <StatusDot />
          <SessionMenu />
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] items-start gap-6 px-5 py-5">
        <div id="primary-rail" className={`${railOpen ? "block" : "hidden"} w-[216px] shrink-0 md:block`}>
          <RailContent />
        </div>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

/** Who is signed in, with what role, and a sign-out button. Absent when the
 * server runs with AUTH_ENABLED=false (nobody to sign out). */
function SessionMenu() {
  const { session, signOut } = useAuth();
  if (!session || !session.auth_enabled) return null;
  return (
    <div className="ml-auto flex items-center gap-3 text-sm">
      <span>
        {session.username} <span className="text-muted">&middot; {session.role}</span>
      </span>
      <button type="button" onClick={() => void signOut()} className="rounded-sm border border-rule-strong bg-sheet px-2 py-1 hover:bg-accent-soft">
        Sign out
      </button>
    </div>
  );
}
