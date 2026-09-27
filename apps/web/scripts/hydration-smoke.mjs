// Hydration smoke check (#1448) — NOT part of CI and not a dependency of the app.
//
// Signs in to a running lazyit web app, opens each page with a full load, and fails when React
// reports a hydration error (#418/#423/#425 in a production build, the "Hydration failed" diff in
// `next dev`). Several of these only show when the app shell warms a query before a streamed page
// segment hydrates, so run it against a production build (`bun run build && bun run start`) with
// real data, and more than once.
//
// It needs `playwright-core` and a Chromium it can drive, neither of which the app installs:
//
//   bun add --cwd /tmp/pw playwright-core            # anywhere outside the repo
//   PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core/index.mjs \
//   CHROMIUM=/path/to/chrome \
//   LAZYIT_EMAIL=admin@example.com LAZYIT_PASSWORD=… \
//   bun scripts/hydration-smoke.mjs [/extra/path …]
//
// Env: BASE_URL (default http://localhost:3000), WAIT_MS per page (default 3000), TZ_ID to run the
// browser in another time zone than the server.

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const WAIT = Number(process.env.WAIT_MS ?? 3000);
const { LAZYIT_EMAIL, LAZYIT_PASSWORD, CHROMIUM } = process.env;

if (!LAZYIT_EMAIL || !LAZYIT_PASSWORD) {
  console.error("Set LAZYIT_EMAIL and LAZYIT_PASSWORD (a local-mode account).");
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core"));
} catch {
  console.error("playwright-core is not resolvable. Install it outside the repo and set PLAYWRIGHT_CORE.");
  process.exit(2);
}

// The list and detail-bearing pages that showed #418 before #1448, plus their neighbours.
const DEFAULT_PAGES = [
  "/dashboard", "/assets", "/assets/servers", "/assets/diagram", "/applications",
  "/applications/access-requests", "/kb", "/consumables", "/locations", "/users", "/imports",
  "/reports", "/reports/audit", "/profile", "/account", "/account/ai", "/account/notifications",
  "/settings", "/settings/ai", "/settings/instance", "/settings/roles",
  "/settings/roles/permissions", "/settings/service-accounts", "/settings/taxonomies",
  "/settings/agents",
];
const pages = [...DEFAULT_PAGES, ...process.argv.slice(2)];
const HYDRATION = /Minified React error #(418|423|425)|Hydration failed|hydration mismatch/i;

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ["--no-sandbox", "--disable-gpu"],
});
const context = await browser.newContext({ timezoneId: process.env.TZ_ID ?? "UTC" });
const page = await context.newPage();
let current = [];
page.on("pageerror", (e) => current.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") current.push(m.text());
});

await page.goto(`${BASE}/login`);
await page.fill("#identifier", LAZYIT_EMAIL);
await page.fill("#password", LAZYIT_PASSWORD);
await page.click("button[type=submit]");
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

const failed = [];
for (const path of pages) {
  current = [];
  await page.goto(BASE + path, { waitUntil: "load" });
  await page.waitForTimeout(WAIT);
  const hits = current.filter((e) => HYDRATION.test(e));
  console.log(`${hits.length ? "FAIL" : "ok  "} ${path}`);
  for (const h of hits) console.log(`     ${h.split("\n")[0].slice(0, 200)}`);
  if (hits.length) failed.push(path);
}

await browser.close();
console.log(`\n${failed.length} of ${pages.length} pages reported a hydration error.`);
process.exit(failed.length ? 1 : 0);
