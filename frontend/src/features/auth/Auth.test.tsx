import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import App from "../../App";
import { UNAUTHORIZED_EVENT } from "../../api/client";

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown };

const reply = (status: number, body?: unknown) =>
  Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function stub(handler: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return reply(status, body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const session = (role: string, auth_enabled = true) => ({ auth_enabled, username: `${role}-user`, role, expires_at: "2026-09-26T19:00:00Z" });

/** Every data endpoint the Home page touches returns an empty result. */
function dataRoutes(url: string) {
  if (url.includes("/health")) return { status: 200, body: { postgres: "ok", mongo: "ok" } };
  if (url.includes("/meta/runs")) return { status: 200, body: { mongo: "ok", runs: [], provenance_checks: [] } };
  if (url.includes("/communities")) return { status: 200, body: { items: [], total: 0, limit: 5, offset: 0 } };
  if (url.includes("/authors/bridges")) return { status: 200, body: { items: [], total: 0, limit: 5, offset: 0 } };
  return { status: 200, body: { items: [], total: 0, limit: 5, offset: 0 } };
}

describe("authentication and roles", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the sign-in screen when there is no session, then the app after signing in", async () => {
    let signedIn = false;
    const fetchMock = stub((url) => {
      if (url.includes("/auth/me")) return signedIn ? { status: 200, body: session("viewer") } : { status: 401, body: { detail: "Not signed in" } };
      if (url.includes("/auth/login")) {
        signedIn = true;
        return { status: 200, body: session("viewer") };
      }
      return dataRoutes(url);
    });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "viewer-user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("viewer-user")).toBeTruthy();

    const loginCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/auth/login"))!;
    const init = loginCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBe("ResearchGraph");
  });

  it("explains wrong credentials and rate limiting without leaving the form", async () => {
    let attempts = 0;
    stub((url) => {
      if (url.includes("/auth/me")) return { status: 401 };
      if (url.includes("/auth/login")) return ++attempts === 1 ? { status: 401, body: { detail: "x" } } : { status: 429, body: { detail: "x" } };
      return dataRoutes(url);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Wrong username or password.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Too many failed attempts/)).toBeTruthy();
  });

  it("hides the query lab and accounts from a viewer, shows them to an admin", async () => {
    stub((url) => (url.includes("/auth/me") ? { status: 200, body: session("viewer") } : dataRoutes(url)));
    const { unmount } = render(<App />);
    expect(await screen.findByText("viewer-user")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Query lab" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Accounts" })).toBeNull();
    unmount();

    stub((url) => (url.includes("/auth/me") ? { status: 200, body: session("admin") } : dataRoutes(url)));
    render(<App />);
    expect(await screen.findByRole("link", { name: "Query lab" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Accounts" })).toBeTruthy();
  });

  it("a typed-in URL for a higher role explains instead of loading the page", async () => {
    window.history.pushState({}, "", "/query-lab");
    stub((url) => (url.includes("/auth/me") ? { status: 200, body: session("viewer") } : dataRoutes(url)));
    render(<App />);
    expect(await screen.findByText(/needs the analyst role; you are signed in as viewer/)).toBeTruthy();
  });

  it("drops to sign-in with an expiry message when a data request comes back 401", async () => {
    stub((url) => (url.includes("/auth/me") ? { status: 200, body: session("viewer") } : dataRoutes(url)));
    render(<App />);
    await screen.findByText("viewer-user");
    act(() => {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    });
    expect(await screen.findByText(/Your session has expired/)).toBeTruthy();
  });

  it("skips sign-in and the session menu when the server has auth disabled", async () => {
    stub((url) => (url.includes("/auth/me") ? { status: 200, body: { ...session("admin", false), username: "anonymous", expires_at: null } } : dataRoutes(url)));
    render(<App />);
    expect(await screen.findByRole("link", { name: "Query lab" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
