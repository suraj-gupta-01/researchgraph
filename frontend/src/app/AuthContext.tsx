import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, UNAUTHORIZED_EVENT } from "../api/client";
import { hasRole, login as apiLogin, logout as apiLogout, me, type Role, type Session } from "../api/auth";

export type AuthState =
  | { status: "loading" }
  | { status: "signedOut"; reason: "none" | "expired" | "signedOut" }
  | { status: "signedIn"; session: Session }
  | { status: "unreachable"; error: ApiError };

interface AuthValue {
  state: AuthState;
  session: Session | null;
  /** True when the signed-in role includes `needed`; always false signed out. */
  can: (needed: Role) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Session state for the whole app (G7). Asks /auth/me once at start; any
 * later 401 from a data endpoint (UNAUTHORIZED_EVENT, fired by api/client)
 * means the session expired, so the app drops to the sign-in screen saying
 * so. The cookie itself is httpOnly: this context only ever holds the
 * username, role and expiry the API reports, never a token. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    me(ctl.signal)
      .then((session) => setState({ status: "signedIn", session }))
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        const err = e as ApiError;
        if (err.kind === "http" && err.status === 401) setState({ status: "signedOut", reason: "none" });
        else setState({ status: "unreachable", error: err });
      });
    return () => ctl.abort();
  }, [nonce]);

  useEffect(() => {
    const onUnauthorized = () =>
      setState((s) => (s.status === "signedIn" && s.session.auth_enabled ? { status: "signedOut", reason: "expired" } : s));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const session = await apiLogin(username, password);
    setState({ status: "signedIn", session });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setState({ status: "signedOut", reason: "signedOut" });
    }
  }, []);

  const value = useMemo<AuthValue>(() => {
    const session = state.status === "signedIn" ? state.session : null;
    return {
      state,
      session,
      can: (needed) => !!session && hasRole(session.role, needed),
      signIn,
      signOut,
      retry: () => {
        setState({ status: "loading" });
        setNonce((n) => n + 1);
      },
    };
  }, [state, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
