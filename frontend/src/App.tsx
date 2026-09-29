import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import ErrorBoundary from "./app/ErrorBoundary";
import { AuthProvider, useAuth } from "./app/AuthContext";
import { ScopeProvider } from "./app/ScopeContext";
import Shell from "./app/Shell";
import NotFound from "./app/NotFound";
import SignIn from "./features/auth/SignIn";
import type { Role } from "./api/auth";

// Route-level code splitting (Phase 9 performance): each screen is its own
// chunk, so the first paint downloads the shell and the one page in view,
// not the graph engine and every chart.
const Home = lazy(() => import("./features/home/Home"));
const Explore = lazy(() => import("./features/explore/Explore"));
const CitationNetworkView = lazy(() => import("./features/citations/CitationNetworkView"));
const PaperPage = lazy(() => import("./features/papers/PaperPage"));
const PapersDirectory = lazy(() => import("./features/papers/PapersDirectory"));
const AuthorPage = lazy(() => import("./features/authors/AuthorPage"));
const AuthorsDirectory = lazy(() => import("./features/authors/AuthorsDirectory"));
const InstitutionPage = lazy(() => import("./features/institutions/InstitutionPage"));
const InstitutionsDirectory = lazy(() => import("./features/institutions/InstitutionsDirectory"));
const InstitutionNetworkView = lazy(() => import("./features/institutions/InstitutionNetworkView"));
const TopInstitutions = lazy(() => import("./features/institutions/TopInstitutions"));
const VenuePage = lazy(() => import("./features/venues/VenuePage"));
const VenuesDirectory = lazy(() => import("./features/venues/VenuesDirectory"));
const TopicPage = lazy(() => import("./features/topics/TopicPage"));
const TopicsDirectory = lazy(() => import("./features/topics/TopicsDirectory"));
const TrendsBoard = lazy(() => import("./features/trends/TrendsBoard"));
const CommunitiesIndex = lazy(() => import("./features/communities/CommunitiesIndex"));
const CommunityPage = lazy(() => import("./features/communities/CommunityPage"));
const CommunityGraphView = lazy(() => import("./features/communities/CommunityGraphView"));
const BridgesBoard = lazy(() => import("./features/bridges/BridgesBoard"));
const ConnectionsBoard = lazy(() => import("./features/connections/ConnectionsBoard"));
const MethodsPage = lazy(() => import("./features/methods/MethodsPage"));
const QueryLab = lazy(() => import("./features/queryLab/QueryLab"));
const Accounts = lazy(() => import("./features/auth/Accounts"));
// Never shipped in a production bundle.
const Styleguide = lazy(() => import("./app/Styleguide"));

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <AuthGate>
          <ScopeProvider>
            <Shell>
              <ErrorBoundary>
                <Suspense fallback={<p className="py-10 text-sm text-muted">Loading&hellip;</p>}>
                  <AppRoutes />
                </Suspense>
              </ErrorBoundary>
            </Shell>
          </ScopeProvider>
        </AuthGate>
      </AuthProvider>
    </BrowserRouter>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/explore" element={<Explore />} />
      {/* Search-scoped, like /communities/graph — same ?q= as /explore (Phase 7, G2). */}
      <Route path="/explore/network" element={<CitationNetworkView />} />

      <Route path="/papers" element={<PapersDirectory />} />
      <Route path="/papers/:id" element={<PaperPage />} />
      <Route path="/authors" element={<AuthorsDirectory />} />
      <Route path="/authors/:id" element={<AuthorPage />} />
      <Route path="/institutions" element={<InstitutionsDirectory />} />
      {/* Static segments before :id, same as /communities/graph. */}
      <Route path="/institutions/network" element={<InstitutionNetworkView />} />
      <Route path="/institutions/top" element={<TopInstitutions />} />
      <Route path="/institutions/:id" element={<InstitutionPage />} />
      <Route path="/venues" element={<VenuesDirectory />} />
      <Route path="/venues/:id" element={<VenuePage />} />
      <Route path="/topics" element={<TopicsDirectory />} />
      <Route path="/topics/:id" element={<TopicPage />} />

      <Route path="/trends" element={<TrendsBoard />} />

      {/* /communities/graph before /communities/:id, matching the backend's
          own route order (communities.py). */}
      <Route path="/communities" element={<CommunitiesIndex />} />
      <Route path="/communities/graph" element={<CommunityGraphView />} />
      <Route path="/communities/:id" element={<CommunityPage />} />

      <Route path="/bridges" element={<BridgesBoard />} />
      <Route path="/connections" element={<ConnectionsBoard />} />
      <Route path="/methods" element={<MethodsPage />} />
      <Route path="/query-lab" element={<RequireRole role="analyst"><QueryLab /></RequireRole>} />
      <Route path="/accounts" element={<RequireRole role="admin"><Accounts /></RequireRole>} />

      {import.meta.env.DEV && <Route path="/styleguide" element={<Styleguide />} />}

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/** Everything behind sign-in (G7). The URL is left untouched while signed
 * out, so the requested page opens right after signing in. */
function AuthGate({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  if (state.status === "loading") return <p className="px-5 py-10 text-sm text-muted">Checking your session&hellip;</p>;
  if (state.status === "unreachable") {
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <p role="alert" className="text-warn">
          {state.error.kind === "network" ? `${state.error.message}. Start the stack with docker compose up -d.` : `Could not check your session (${state.error.message}).`}
        </p>
        <button type="button" onClick={retry} className="mt-4 rounded-sm border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-accent-soft">
          Try again
        </button>
      </div>
    );
  }
  if (state.status === "signedOut") return <SignIn reason={state.reason} />;
  return <>{children}</>;
}

/** A page some roles may not use. Its nav entry is hidden for them; a
 * typed-in URL gets this explanation instead of a page the API would refuse. */
function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { can, session } = useAuth();
  if (can(role)) return <>{children}</>;
  return <NotFound message={`This page needs the ${role} role; you are signed in as ${session?.role ?? "a guest"}.`} />;
}
