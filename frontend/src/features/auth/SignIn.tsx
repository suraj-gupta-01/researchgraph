import { useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { useAuth } from "../../app/AuthContext";

const REASON: Record<string, string> = {
  expired: "Your session has expired. Sign in again to continue where you were.",
  signedOut: "You have signed out.",
};

/** Sign-in screen (G7). Shown in place of every route while signed out,
 * so the URL the viewer asked for is kept and reopens once they sign in. */
export default function SignIn({ reason }: { reason: "none" | "expired" | "signedOut" }) {
  const { signIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      const ae = err as ApiError;
      if (ae.kind === "network") setError(`${ae.message}. Start the stack with docker compose up -d.`);
      else if (ae.status === 401) setError("Wrong username or password.");
      else if (ae.status === 429) setError("Too many failed attempts. Wait a few minutes, then try again.");
      else if (ae.status === 422) setError("Enter a username and a password.");
      else setError(`Sign-in failed (${ae.message}).`);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <p className="font-serif text-2xl font-semibold tracking-tight">ResearchGraph</p>
      <h1 className="mt-6 font-serif text-xl font-semibold">Sign in</h1>
      {REASON[reason] && (
        <p role="status" className="mt-3 rounded border border-rule-strong bg-sheet px-3 py-2 text-sm">
          {REASON[reason]}
        </p>
      )}
      <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
        <label className="block text-sm">
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            maxLength={64}
            className="mt-1 block w-full rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            maxLength={256}
            className="mt-1 block w-full rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-warn">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !username || !password} className="w-full rounded-sm bg-accent px-4 py-2 font-medium text-white hover:bg-ink disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="mt-6 text-xs text-muted">Accounts are configured on the server (AUTH_USERS). Ask the person running this instance for one.</p>
    </main>
  );
}
