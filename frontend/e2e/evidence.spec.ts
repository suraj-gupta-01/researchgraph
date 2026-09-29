import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 9 evidence pack, in a real browser against the running stack:
 * every route at 1440 and 390 px -> a full-page screenshot, a page-level
 * horizontal-overflow check, console errors and CSP violations, and an axe
 * WCAG 2.1 A/AA audit. Findings go to docs/evidence/report.json and fail
 * the run, so this is a gate, not only a camera.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// E2E_OUT keeps a run against another stack (e.g. the large-corpus
// performance check) from overwriting the committed evidence pack.
const OUT = process.env.E2E_OUT ?? join(HERE, "..", "..", "docs", "evidence");
const USER = process.env.E2E_USER ?? "admin";
const PASS = process.env.E2E_PASSWORD ?? "admin-demo";
const API = process.env.E2E_API_URL ?? "http://localhost:8000";
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];

interface Finding {
  route: string;
  viewport: string;
  overflowPx: number;
  consoleErrors: string[];
  cspViolations: string[];
  axe: { id: string; impact: string | null | undefined; help: string; nodes: number; targets: string[] }[];
  loadMs: number;
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel("Password").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function firstId(page: Page, path: string, key: string): Promise<number> {
  const r = await page.request.get(`${API}${path}`);
  expect(r.ok(), `${path} -> ${r.status()}`).toBeTruthy();
  const body = await r.json();
  const items = Array.isArray(body) ? body : body.items;
  return items[0][key];
}

/** Waits until the page has settled: network quiet and no loading copy. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page
    .waitForFunction(() => !/Loading|Running|Checking your session/.test(document.body.innerText), undefined, { timeout: 20_000 })
    .catch(() => undefined);
  // force layouts are synchronous but the SVG size follows a ResizeObserver tick
  await page.waitForTimeout(300);
}

test("every route at 1440 and 390 px: screenshot, overflow, console, CSP, axe", async ({ browser }) => {
  const findings: Finding[] = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    await context.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    // The sign-in screen itself is a route to check.
    await page.goto("/");
    await settle(page);
    const shots = join(OUT, "screens", vp.name);
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, "00-sign-in.png"), fullPage: true });
    findings.push(await audit(page, "sign-in", vp.name, consoleErrors, 0));

    await signIn(page);
    const ids = {
      paper: await firstId(page, "/search/papers?q=federated%20learning&sort=citations&limit=1", "paper_id"),
      author: await firstId(page, "/authors?sort=papers&limit=1", "author_id"),
      institution: await firstId(page, "/institutions?sort=papers&limit=1", "institution_id"),
      venue: await firstId(page, "/venues?sort=papers&limit=1", "venue_id"),
      topic: await firstId(page, "/topics/trending?limit=1", "topic_id"),
      community: await firstId(page, "/communities?limit=1", "community_id"),
    };
    const routes: [string, string][] = [
      ["home", "/"],
      ["explore-landing", "/explore"],
      ["explore", "/explore?q=federated%20learning"],
      ["citation-network", "/explore/network?q=federated%20learning"],
      ["paper", `/papers/${ids.paper}`],
      ["papers", "/papers"],
      ["authors", "/authors"],
      ["author", `/authors/${ids.author}`],
      ["institutions", "/institutions"],
      ["institution", `/institutions/${ids.institution}`],
      ["institution-network", "/institutions/network"],
      ["top-institutions", "/institutions/top"],
      ["venues", "/venues"],
      ["venue", `/venues/${ids.venue}`],
      ["topics", "/topics"],
      ["topic", `/topics/${ids.topic}`],
      ["trends", "/trends"],
      ["communities", "/communities?q=federated%20learning"],
      ["community", `/communities/${ids.community}`],
      ["community-graph", "/communities/graph"],
      ["bridges", "/bridges"],
      ["connections", "/connections"],
      ["methods", "/methods"],
      ["query-lab", `/query-lab?query=topic-authors&topic=${ids.topic}&topicName=topic&from=2018&to=2025`],
      ["query-lab-chain", `/query-lab?query=citation-chain&paper=${ids.paper}&paperName=paper&dir=cited_by&depth=3`],
      ["accounts", "/accounts"],
      ["not-found", "/no-such-page"],
    ];

    for (const [i, [name, path]] of routes.entries()) {
      consoleErrors.length = 0;
      const t0 = Date.now();
      await page.goto(path);
      await settle(page);
      const loadMs = Date.now() - t0;
      await page.screenshot({ path: join(shots, `${String(i + 1).padStart(2, "0")}-${name}.png`), fullPage: true });
      findings.push(await audit(page, name, vp.name, consoleErrors, loadMs));
    }
    await context.close();
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), JSON.stringify(findings, null, 2));

  // The sign-in screen's session check (/auth/me) answers 401 by design,
  // and the browser logs every 4xx fetch; that one line is expected there.
  for (const f of findings) {
    if (f.route === "sign-in") f.consoleErrors = f.consoleErrors.filter((c) => !/status of 401/.test(c));
  }
  writeFileSync(join(OUT, "report.json"), JSON.stringify(findings, null, 2));

  const problems = findings.filter((f) => f.overflowPx > 0 || f.consoleErrors.length || f.cspViolations.length || f.axe.some((a) => a.impact === "serious" || a.impact === "critical"));
  expect(
    problems.map((p) => ({
      route: `${p.route}@${p.viewport}`,
      overflowPx: p.overflowPx,
      console: p.consoleErrors,
      csp: p.cspViolations,
      axe: p.axe.filter((a) => a.impact === "serious" || a.impact === "critical").map((a) => `${a.id} (${a.nodes}): ${a.targets.join(" | ")}`),
    })),
  ).toEqual([]);
});

async function audit(page: Page, route: string, viewport: string, consoleErrors: string[], loadMs: number): Promise<Finding> {
  const overflowPx = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
  const cspViolations = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return {
    route,
    viewport,
    overflowPx,
    consoleErrors: [...consoleErrors],
    cspViolations,
    loadMs,
    axe: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")),
    })),
  };
}
