#!/usr/bin/env bun
/**
 * lazyit — one-command dev bootstrap (issue #483).
 *
 * Turns the long manual dev bring-up into a single command, with two modes. Idempotent and
 * fail-loud. Dev auth is LOCAL (ADR-0086); there is no bundled dev IdP (ADR-0102) — to try OIDC in
 * dev, point apps/{api,web}/.env at your own IdP by hand.
 *
 *   bun scripts/dev-setup.ts --up      (default) bring services up + fresh Prisma client + start apps
 *   bun scripts/dev-setup.ts --fresh   wipe dev state, rebuild from zero, wire env (local auth)
 *
 * Flags:
 *   --fresh      destructive full rebuild (requires a typed "yes" unless --yes is passed)
 *   --up         (default) non-destructive: assumes --fresh ran before
 *   --yes / -y   skip the --fresh confirmation prompt (CI / unattended)
 *   --no-start   do all prep but DON'T `bun run dev` at the end (runnable in CI/tests)
 *
 * Bun-first (CLAUDE.md "Bun usage — SCOPED"): uses `Bun.$` for processes and `Bun.file` for I/O.
 * The `.env` files it writes are gitignored — no secret lands in a git-tracked file.
 *
 * SAFETY: `--fresh` removes the dev Docker volumes (lazyit_*). It is gated behind a typed
 * confirmation. Never run it against a stack you care about without understanding what it wipes.
 */

import { $ } from "bun";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants — the dev recipe verified working this session (issue #483).
// ---------------------------------------------------------------------------

/** Repo root = parent of scripts/ (this file lives at <root>/scripts/dev-setup.ts). */
const REPO_ROOT = join(import.meta.dir, "..");

/** Dev volumes removed by --fresh (compose project `lazyit`). Mirrors `docker compose down -v`. */
const DEV_VOLUMES = [
  "lazyit_db_data",
  // Left over from the removed bundled dev Zitadel (ADR-0102); listed so --fresh reclaims them.
  "lazyit_zitadel_db_data",
  "lazyit_zitadel_secrets",
  // Meilisearch data is one volume per server version (ADR-0035 amendment 2026-09-26). The legacy
  // v1.12 `lazyit_meili_data` stays listed so --fresh also reclaims it on machines that still have it.
  "lazyit_meili_data_v1_53_2",
  "lazyit_meili_data",
  "lazyit_valkey_data",
] as const;

/** Dev web origin (where /setup and /login live). */
const WEB_ORIGIN = "http://localhost:3000";

/** Health-wait tuning (poll db). */
const HEALTH_RETRIES = 60;
const HEALTH_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// Tiny logging + fail-loud helpers.
// ---------------------------------------------------------------------------

const log = (msg: string) => console.log(`[dev-setup] ${msg}`);
const warn = (msg: string) => console.warn(`[dev-setup] WARN: ${msg}`);

/** Print an error and exit non-zero — never swallow failures. */
function fail(msg: string): never {
  console.error(`[dev-setup] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

interface Options {
  mode: "fresh" | "up";
  yes: boolean;
  noStart: boolean;
}

function parseArgs(argv: string[]): Options {
  let fresh = false;
  let up = false;
  let yes = false;
  let noStart = false;

  for (const arg of argv) {
    switch (arg) {
      case "--fresh":
        fresh = true;
        break;
      case "--up":
        up = true;
        break;
      case "--yes":
      case "-y":
        yes = true;
        break;
      case "--no-start":
        noStart = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        fail(`unknown flag: ${arg} (use --fresh | --up | --yes | --no-start | --help)`);
    }
  }

  if (fresh && up) fail("--fresh and --up are mutually exclusive");
  // --up is the default when neither is given.
  return { mode: fresh ? "fresh" : "up", yes, noStart };
}

function printUsage(): void {
  console.log(
    [
      "lazyit dev bootstrap (issue #483)",
      "",
      "  bun scripts/dev-setup.ts [--up | --fresh] [--yes] [--no-start]",
      "",
      "  --up        (default) bring services up + refresh the Prisma client, then start the apps.",
      "              Assumes --fresh ran before. Does NOT touch .env.",
      "  --fresh     wipe dev state and rebuild from zero: remove dev volumes, bring services up,",
      "              migrate+generate+seed, wire apps/{web,api}/.env, then start.",
      "              DESTRUCTIVE — requires a typed 'yes' unless --yes is passed.",
      "  --yes, -y   skip the --fresh confirmation prompt (CI / unattended).",
      "  --no-start  do all prep but do NOT run `bun run dev` at the end (CI/tests).",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Preflight — assert the host tools exist.
// ---------------------------------------------------------------------------

async function assertHostTools(tools: string[]): Promise<void> {
  const missing: string[] = [];
  for (const tool of tools) {
    // `which` exits non-zero when the tool is absent; .nothrow() so we can inspect it.
    const res = await $`which ${tool}`.quiet().nothrow();
    if (res.exitCode !== 0) missing.push(tool);
  }
  if (missing.length > 0) {
    fail(
      `missing required host tool(s): ${missing.join(", ")}. ` +
        `Install them (macOS: \`brew install ${missing.join(" ")}\`) and re-run.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Docker helpers.
// ---------------------------------------------------------------------------

/** Bring up the dev backing services — db, meilisearch, valkey (auto-merges compose.override.yaml). */
async function composeUp(): Promise<void> {
  log("bringing up backing services: docker compose up -d");
  // cwd = repo root so compose.yaml + compose.override.yaml are auto-discovered.
  await $`docker compose up -d`.cwd(REPO_ROOT);
}

/**
 * Remove the dev volumes for a clean rebuild (--fresh step 1). Uses `docker compose down -v`
 * to stop+remove containers AND named volumes for this project, then removes any of the named
 * dev volumes that linger (e.g. created out-of-band). Fail-loud on unexpected errors.
 */
async function wipeDevVolumes(): Promise<void> {
  log("removing dev containers + volumes: docker compose down -v");
  await $`docker compose down -v`.cwd(REPO_ROOT);

  // Belt-and-suspenders: drop any named dev volume that survived (idempotent — ignore "no such").
  for (const vol of DEV_VOLUMES) {
    const res = await $`docker volume rm ${vol}`.quiet().nothrow();
    if (res.exitCode === 0) {
      log(`  - removed volume ${vol}`);
    } // a non-zero here just means it was already gone — fine.
  }
}

/**
 * Poll until the `db` compose service reports healthy. Reads the container health status via
 * `docker compose ps` (JSON). Fail-loud on timeout.
 */
async function waitForDbHealthy(): Promise<void> {
  log("waiting for the `db` service to become healthy ...");
  for (let i = 0; i < HEALTH_RETRIES; i++) {
    const res = await $`docker compose ps db --format json`.cwd(REPO_ROOT).quiet().nothrow();
    if (res.exitCode === 0) {
      const text = res.stdout.toString().trim();
      // `docker compose ps --format json` emits one JSON object per line (or a single object).
      for (const line of text.split("\n").filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj.Service === "db" && typeof obj.Health === "string") {
            if (obj.Health === "healthy") {
              log("`db` is healthy.");
              return;
            }
          }
        } catch {
          // ignore a malformed line; retry below.
        }
      }
    }
    await Bun.sleep(HEALTH_INTERVAL_MS);
  }
  fail(`the \`db\` service did not become healthy within ${(HEALTH_RETRIES * HEALTH_INTERVAL_MS) / 1000}s`);
}

// ---------------------------------------------------------------------------
// Prisma — migrate + generate + seed (--fresh) or just generate (--up).
// ---------------------------------------------------------------------------

const API_DIR = join(REPO_ROOT, "apps", "api");

async function prismaFresh(): Promise<void> {
  log("applying migrations: bunx prisma migrate deploy");
  await $`bunx prisma migrate deploy`.cwd(API_DIR);
  // Explicit generate matters: `migrate deploy` does NOT regenerate the client; a stale client
  // breaks the API boot (#480).
  log("regenerating the Prisma client: bunx prisma generate");
  await $`bunx prisma generate`.cwd(API_DIR);
  log("seeding initial data: bunx prisma db seed");
  await $`bunx prisma db seed`.cwd(API_DIR);
}

async function prismaGenerateOnly(): Promise<void> {
  // Cheap; keeps the generated client fresh so a stale client can't break the API boot (#480).
  log("refreshing the Prisma client: bunx prisma generate");
  await $`bunx prisma generate`.cwd(API_DIR);
}

// ---------------------------------------------------------------------------
// .env wiring — idempotent match-and-replace (never duplicate lines).
// ---------------------------------------------------------------------------

/**
 * Set KEY=value in an env file's text, idempotently. Replaces the FIRST occurrence of an existing
 * `KEY=...` OR a commented `# KEY=...` line in place; appends a new line only if the key is absent.
 * Never produces duplicate keys.
 */
function setEnvKey(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  // Match `KEY=...`, `KEY =...`, `# KEY=...`, `#KEY=...` (optional leading-comment + whitespace).
  const re = new RegExp(`^(\\s*#\\s*)?${escapeRegExp(key)}\\s*=`);
  const idx = lines.findIndex((line) => re.test(line));
  const newLine = `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = newLine;
    return lines.join("\n");
  }
  // Append (preserve a trailing newline shape).
  if (text.length > 0 && !text.endsWith("\n")) lines.push("");
  lines.push(newLine);
  return lines.join("\n");
}

/**
 * Comment OUT a `KEY=...` line in place (idempotent). If the key is already commented or absent,
 * the text is returned unchanged.
 */
function commentOutEnvKey(text: string, key: string): string {
  const lines = text.split("\n");
  const activeRe = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (activeRe.test(lines[i])) {
      lines[i] = `# ${lines[i].replace(/^\s+/, "")}`;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read an env file, or fall back to copying its committed .env.example if missing. */
async function readOrSeedEnv(envPath: string, examplePath: string): Promise<string> {
  const envFile = Bun.file(envPath);
  if (await envFile.exists()) return envFile.text();
  const example = Bun.file(examplePath);
  if (!(await example.exists())) fail(`neither ${envPath} nor its example ${examplePath} exists`);
  log(`creating ${envPath} from ${examplePath}`);
  const text = await example.text();
  await Bun.write(envPath, text);
  return text;
}

/**
 * Read an existing SESSION_SIGNING_SECRET from env text, reusing it when it is already a valid
 * (>= 32-char, non-placeholder) secret so repeated --fresh runs don't needlessly log everyone out;
 * otherwise mint a fresh 64-hex-char one (node:crypto — no openssl host-tool needed in local mode).
 */
function resolveDevSessionSecret(apiEnvText: string): string {
  const m = apiEnvText.match(/^\s*SESSION_SIGNING_SECRET\s*=\s*(.+)$/m);
  const existing = m?.[1]?.trim();
  if (existing && existing.length >= 32 && !/CHANGE_ME/i.test(existing)) return existing;
  return randomBytes(32).toString("hex"); // 64 hex chars — satisfies the >= 32 boot assertion (ADR-0086 §4)
}

/**
 * Wire the env files for LOCAL auth (ADR-0086): AUTH_MODE=local + a dev SESSION_SIGNING_SECRET on the
 * API (which signs its own sessions), and AUTH_MODE=local on the web (so the login surface renders the
 * built-in Credentials flow, not OIDC).
 */
async function wireLocalEnv(): Promise<void> {
  // apps/api/.env — AUTH_MODE=local + a valid SESSION_SIGNING_SECRET; comment out the OIDC vars (unused
  // in local mode) so a stale IdP URL can't confuse anyone reading the file.
  const apiEnvPath = join(REPO_ROOT, "apps", "api", ".env");
  const apiExample = join(REPO_ROOT, "apps", "api", ".env.example");
  let apiText = await readOrSeedEnv(apiEnvPath, apiExample);
  apiText = setEnvKey(apiText, "AUTH_MODE", "local");
  apiText = setEnvKey(apiText, "SESSION_SIGNING_SECRET", resolveDevSessionSecret(apiText));
  apiText = commentOutEnvKey(apiText, "OIDC_ISSUER");
  apiText = commentOutEnvKey(apiText, "OIDC_JWKS_URI");
  await Bun.write(apiEnvPath, apiText);
  log(`wired apps/api/.env (AUTH_MODE=local, SESSION_SIGNING_SECRET set, OIDC vars off).`);

  // apps/web/.env — AUTH_MODE=local so the web renders the local login surface (Credentials provider).
  const webEnvPath = join(REPO_ROOT, "apps", "web", ".env");
  const webExample = join(REPO_ROOT, "apps", "web", ".env.example");
  let webText = await readOrSeedEnv(webEnvPath, webExample);
  webText = setEnvKey(webText, "AUTH_MODE", "local");
  await Bun.write(webEnvPath, webText);
  log(`wired apps/web/.env (AUTH_MODE=local).`);
}

// ---------------------------------------------------------------------------
// Confirmation prompt for --fresh (destructive).
// ---------------------------------------------------------------------------

async function confirmFresh(): Promise<void> {
  console.log("");
  warn("--fresh is DESTRUCTIVE. It will REMOVE these Docker volumes (all dev data is lost):");
  for (const vol of DEV_VOLUMES) console.log(`         - ${vol}`);
  console.log("");
  process.stdout.write("[dev-setup] Type 'yes' to continue: ");

  // Read a single line from stdin.
  const answer = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(chunk.toString().trim());
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });

  if (answer.toLowerCase() !== "yes") fail("aborted (confirmation not given).");
}

// ---------------------------------------------------------------------------
// Start the apps (unless --no-start).
// ---------------------------------------------------------------------------

async function startApps(): Promise<void> {
  log("starting the apps: bun run dev (web → :3000, api → :3001). Ctrl-C to stop.");
  // Hand the terminal over to turbo dev. This is the last step — it runs in the foreground.
  await $`bun run dev`.cwd(REPO_ROOT);
}

function printNextSteps(): void {
  console.log("");
  log("Local auth is wired (AUTH_MODE=local). Next steps:");
  log(`  1. open ${WEB_ORIGIN}/setup  — create the first admin ONCE`);
  log(`  2. then ${WEB_ORIGIN}/login`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Mode orchestration.
// ---------------------------------------------------------------------------

async function runFresh(opts: Options): Promise<void> {
  log("MODE: --fresh (wipe dev state, rebuild from zero, wire local auth)");

  // Only docker: the dev SESSION_SIGNING_SECRET comes from node:crypto, not openssl.
  await assertHostTools(["docker"]);

  if (!opts.yes) await confirmFresh();

  // 1. Remove dev volumes.
  await wipeDevVolumes();

  // 2. Bring up backing services.
  await composeUp();

  // 3. Wait for db healthy.
  await waitForDbHealthy();

  // 4. Prisma: migrate deploy + generate (explicit — #480) + seed.
  await prismaFresh();

  // 5. Wire local auth: AUTH_MODE=local + a dev SESSION_SIGNING_SECRET on the api, AUTH_MODE=local on the web.
  await wireLocalEnv();

  // 6. Print next steps, then start (unless --no-start).
  printNextSteps();
  if (opts.noStart) {
    log("--no-start: prep complete, NOT starting the apps. Run `bun run dev` when ready.");
    return;
  }
  await startApps();
}

async function runUp(opts: Options): Promise<void> {
  log("MODE: --up (bring services up + refresh the Prisma client, then start). Assumes --fresh ran before.");
  await assertHostTools(["docker"]);

  await composeUp();
  await waitForDbHealthy();
  await prismaGenerateOnly();

  if (opts.noStart) {
    log("--no-start: services up and client fresh, NOT starting the apps. Run `bun run dev` when ready.");
    return;
  }
  await startApps();
}

// ---------------------------------------------------------------------------
// Entrypoint.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "fresh") {
    await runFresh(opts);
  } else {
    await runUp(opts);
  }
}

await main();
