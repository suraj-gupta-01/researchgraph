import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { listAccounts, type Account } from "../../api/auth";
import ScrollRegion from "../../components/ScrollRegion";

const ROLE_TEXT: Record<string, string> = {
  viewer: "Every dashboard, directory and entity page",
  analyst: "Viewer, plus the Section 9 query lab (raw SQL and schema)",
  admin: "Analyst, plus this account list",
};

/** /accounts (admin, G7): who can sign in and with which role. Read-only:
 * accounts live in the server's AUTH_USERS setting, so changing them is a
 * deployment change, not a UI action. Passwords are never returned. */
export default function Accounts() {
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    listAccounts(ctl.signal)
      .then(setRows)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e as ApiError);
      });
    return () => ctl.abort();
  }, []);

  return (
    <div className="max-w-3xl pb-16">
      <h1 className="font-serif text-[28px] font-semibold leading-tight">Accounts</h1>
      <p className="mt-2 max-w-[68ch] text-base text-muted">
        Accounts and roles come from the server&rsquo;s <code className="font-mono text-[14px]">AUTH_USERS</code> setting. To add, remove or change one, edit it in <code className="font-mono text-[14px]">.env</code> and restart the backend. A role change applies on the account&rsquo;s next request.
      </p>
      {error && <p role="alert" className="mt-5 text-sm text-warn">Could not load accounts ({error.message}).</p>}
      {!rows && !error && <p className="mt-5 text-sm text-muted">Loading&hellip;</p>}
      {rows && (
        <ScrollRegion label="Configured accounts" className="mt-5 border border-rule">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Configured accounts</caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Username</th>
                <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Role</th>
                <th scope="col" className="border-b border-rule px-3 py-2 text-left font-semibold">Can use</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.username} className="border-b border-rule last:border-b-0">
                  <td className="px-3 py-2">{a.username}</td>
                  <td className="px-3 py-2">{a.role}</td>
                  <td className="px-3 py-2 text-muted">{ROLE_TEXT[a.role] ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </div>
  );
}
