import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";

interface ScopeContextValue {
  scope: string;
  setScope: (q: string) => void;
  /** Commits the scope and navigates to the primary scoped view (Explore
   * today; Communities/Bridges read the same value once their phases land). */
  submitScope: (q: string) => void;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

/** Pages whose own `?q=` the top bar reads and writes directly, because F2/F4
 * are defined "for a searched topic" (design-system.md §3): Communities and
 * Bridge researchers read the same scope as Explore, and so does its
 * citation network (Phase 7, G2). Trends and Connections are deliberately
 * absent — neither /topics/trending nor /topics/converging takes a topic
 * filter, and each board says so. */
const SCOPED_PATHS = ["/explore", "/explore/network", "/communities", "/bridges"];

export function ScopeProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const onScopedPath = SCOPED_PATHS.includes(location.pathname);
  const urlScope = new URLSearchParams(location.search).get("q") ?? "";
  const [draft, setDraft] = useState(urlScope);

  const value = useMemo<ScopeContextValue>(
    () => ({
      scope: onScopedPath ? urlScope : draft,
      setScope: setDraft,
      submitScope: (q: string) => {
        const t = q.trim();
        setDraft(t);
        // Stay on a scoped page (e.g. searching from Communities re-searches
        // Communities); everywhere else, a search means "go explore this".
        const base = onScopedPath ? location.pathname : "/explore";
        navigate(t ? `${base}?q=${encodeURIComponent(t)}` : base);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [location.pathname, onScopedPath, urlScope, draft, navigate],
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error("useScope must be used inside ScopeProvider");
  return ctx;
}
