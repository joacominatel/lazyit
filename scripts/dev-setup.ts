#!/usr/bin/env bun
/**
 * lazyit — one-command dev bootstrap (issue #483).
 *
 * Turns the long manual dev bring-up into a single command, with two modes. It mirrors the
 * robustness of the prod `infra/scripts/zitadel-bootstrap.sh`: idempotent and fail-loud. This
 * resolves the dev-auth part of #481 (dev Zitadel auto-bootstrap) and #477 (Zitadel dev volume
 * perms — also fixed at the compose level in `compose.override.yaml`).
 *
 *   bun scripts/dev-setup.ts --up      (default) bring services up + fresh Prisma client + start apps
 *   bun scripts/dev-setup.ts --fresh   wipe dev state, rebuild from zero, bootstrap Zitadel + wire env
 *
 * Flags:
 *   --fresh      destructive full rebuild (requires a typed "yes" unless --yes is passed)
 *   --up         (default) non-destructive: assumes --fresh ran before and Zitadel is bootstrapped
 *   --yes / -y   skip the --fresh confirmation prompt (CI / unattended)
 *   --no-start   do all prep but DON'T `bun run dev` at the end (runnable in CI/tests)
 *
 * Bun-first (CLAUDE.md "Bun usage — SCOPED"): uses `Bun.$` for processes and `Bun.file` for I/O.
 * It REUSES `infra/scripts/zitadel-bootstrap.sh` for the Zitadel provisioning — it does NOT
 * reimplement it. Secrets (the SA key, the OIDC client secret) never land in a git-tracked file:
 * the `.env` files are gitignored, and `sa-key.json` is stashed OUTSIDE the repo tree under
 * ~/.lazyit-dev (mode 0600).
 *
 * SAFETY: `--fresh` removes the dev Docker volumes (lazyit_*). It is gated behind a typed
 * confirmation. Never run it against a stack you care about without understanding what it wipes.
 */

import { $ } from "bun";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, chmod, readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Constants — the dev recipe verified working this session (issue #483).
// ---------------------------------------------------------------------------

/** Repo root = parent of scripts/ (this file lives at <root>/scripts/dev-setup.ts). */
const REPO_ROOT = join(import.meta.dir, "..");

/** Compose project name (compose.yaml `name: lazyit`) → volumes are prefixed `lazyit_`. */
const COMPOSE_PROJECT = "lazyit";

/** Dev volumes removed by --fresh. Mirrors `docker compose down -v` for this project. */
const DEV_VOLUMES = [
  "lazyit_db_data",
  "lazyit_zitadel_db_data",
  "lazyit_zitadel_secrets",
  "lazyit_meili_data",
  "lazyit_valkey_data",
] as const;

/** The shared secrets volume Zitadel writes bootstrap-key.json into (and the sidecar reads). */
const ZITADEL_SECRETS_VOLUME = `${COMPOSE_PROJECT}_zitadel_secrets`;

/** Dev endpoints (compose.override.yaml publishes Zitadel on loopback :8080). */
const ZITADEL_URL = "http://localhost:8080";
const WEB_ORIGIN = "http://localhost:3000";

/** Where the runtime SA key is stashed — OUTSIDE the repo tree, mode 0600 (never tracked). */
const SA_KEY_STASH_DIR = join(homedir(), ".lazyit-dev");
const SA_KEY_STASH_PATH = join(SA_KEY_STASH_DIR, "sa-key.json");

/** The reusable prod bootstrap script — run on the host for dev (NOT reimplemented). */
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, "infra", "scripts", "zitadel-bootstrap.sh");

/** alpine image used for throwaway volume reads (matches the prod secrets-init digest family). */
const ALPINE_IMAGE = "alpine:3.21";

/** Health-wait tuning (poll db + Zitadel). */
const HEALTH_RETRIES = 60;
const HEALTH_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// Tiny logging + fail-loud helpers (mirror the bootstrap script's log/fail).
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
      "              Assumes --fresh ran before (Zitadel already bootstrapped). Does NOT touch .env.",
      "  --fresh     wipe dev state and rebuild from zero: remove dev volumes, bring services up,",
      "              migrate+generate+seed, bootstrap Zitadel, wire apps/{web,api}/.env, then start.",
      "              DESTRUCTIVE — requires a typed 'yes' unless --yes is passed.",
      "  --yes, -y   skip the --fresh confirmation prompt (CI / unattended).",
      "  --no-start  do all prep but do NOT run `bun run dev` at the end (CI/tests).",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Preflight — assert the host tools the reused bootstrap script needs exist.
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

/** Bring up the unprofiled backing services (auto-merges compose.override.yaml). */
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

/**
 * Poll Zitadel's /debug/healthz until HTTP 200. The Zitadel image is shell-less (no container
 * healthcheck), so we probe the published loopback endpoint directly. Fail-loud on timeout.
 */
async function waitForZitadelHealthy(): Promise<void> {
  log(`waiting for Zitadel health at ${ZITADEL_URL}/debug/healthz ...`);
  for (let i = 0; i < HEALTH_RETRIES; i++) {
    try {
      const resp = await fetch(`${ZITADEL_URL}/debug/healthz`);
      if (resp.ok) {
        log("Zitadel is healthy.");
        return;
      }
    } catch {
      // connection refused while Zitadel boots — retry below.
    }
    await Bun.sleep(HEALTH_INTERVAL_MS);
  }
  fail(`Zitadel did not become healthy within ${(HEALTH_RETRIES * HEALTH_INTERVAL_MS) / 1000}s`);
}

/**
 * Copy a file out of a Docker named volume to a host path, using a throwaway alpine container
 * that mounts the volume read-only and `cat`s the file to stdout (captured to the host file).
 * Returns true if the file existed and was copied, false otherwise.
 */
async function copyFromVolume(volume: string, fileInVolume: string, hostDest: string): Promise<boolean> {
  const res =
    await $`docker run --rm -v ${volume}:/vol:ro ${ALPINE_IMAGE} sh -c ${`cat /vol/${fileInVolume} 2>/dev/null || true`}`
      .quiet()
      .nothrow();
  if (res.exitCode !== 0) {
    fail(`failed to read ${fileInVolume} from volume ${volume}: ${res.stderr.toString().trim()}`);
  }
  const bytes = res.stdout;
  if (bytes.length === 0) return false;
  await Bun.write(hostDest, bytes);
  return true;
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
// Zitadel bootstrap — REUSE infra/scripts/zitadel-bootstrap.sh (not reimplemented).
// ---------------------------------------------------------------------------

interface OidcClient {
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  OIDC_JWKS_URI: string;
  ZITADEL_MGMT_PROJECT_ID: string;
}

/**
 * Run the prod bootstrap script on the HOST against the dev Zitadel and return the OIDC client
 * config it writes. The script reads ZITADEL_SECRETS_DIR (NOT SECRETS_DIR) and fails if the dir
 * isn't present, so we copy bootstrap-key.json out of the volume into a fresh tmpdir first. It
 * writes oidc-client.json + sa-key.json into that tmpdir. We stash sa-key.json outside the tree.
 */
async function bootstrapZitadel(): Promise<OidcClient> {
  const secretsDir = await mkdtemp(join(tmpdir(), "lazyit-zitadel-"));
  try {
    // The bootstrap script reads <secretsDir>/bootstrap-key.json (written by Zitadel start-from-init).
    log(`copying bootstrap-key.json out of volume ${ZITADEL_SECRETS_VOLUME} ...`);
    const copied = await copyFromVolume(ZITADEL_SECRETS_VOLUME, "bootstrap-key.json", join(secretsDir, "bootstrap-key.json"));
    if (!copied) {
      fail(
        `bootstrap-key.json not found in volume ${ZITADEL_SECRETS_VOLUME}. Zitadel should export it on ` +
          `first boot (compose.override.yaml chmods the volume so the non-root uid can write it). ` +
          `Check \`docker compose logs zitadel\` and \`docker compose logs zitadel-secrets-init\`.`,
      );
    }

    log(`running the prod bootstrap script (reused, NOT reimplemented): ${BOOTSTRAP_SCRIPT}`);
    // Same env contract the prod sidecar uses, mapped to dev loopback endpoints. The script
    // short-circuits if oidc-client.json + sa-key.json already exist in the dir — the tmpdir is
    // fresh each run, so --fresh always provisions cleanly.
    await $`sh ${BOOTSTRAP_SCRIPT}`.env({
      ...process.env,
      ZITADEL_SECRETS_DIR: secretsDir,
      ZITADEL_INTERNAL_URL: ZITADEL_URL,
      OIDC_ISSUER: ZITADEL_URL,
      WEB_ORIGIN: WEB_ORIGIN,
    });

    // Read the two outputs the script wrote.
    const oidcPath = join(secretsDir, "oidc-client.json");
    const saPath = join(secretsDir, "sa-key.json");
    const oidcText = await readFile(oidcPath, "utf8").catch(() =>
      fail(`bootstrap did not write ${oidcPath} — check its output above`),
    );
    const oidc = JSON.parse(oidcText) as OidcClient;
    if (!oidc.OIDC_CLIENT_ID || !oidc.OIDC_CLIENT_SECRET || !oidc.ZITADEL_MGMT_PROJECT_ID) {
      fail(`oidc-client.json is missing required keys (got: ${Object.keys(oidc).join(", ")})`);
    }

    // Stash the SA key OUTSIDE the repo tree (mode 0600). NEVER inside the tracked tree.
    await mkdir(SA_KEY_STASH_DIR, { recursive: true, mode: 0o700 });
    const saBytes = await readFile(saPath).catch(() => fail(`bootstrap did not write ${saPath}`));
    await Bun.write(SA_KEY_STASH_PATH, saBytes);
    await chmod(SA_KEY_STASH_PATH, 0o600);
    log(`stashed the runtime SA key at ${SA_KEY_STASH_PATH} (chmod 600, outside the repo tree).`);

    return oidc;
  } finally {
    // The tmpdir held bootstrap-key.json + the client secret + the SA key — scrub it.
    await rm(secretsDir, { recursive: true, force: true });
  }
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
 * the text is returned unchanged. Used to disable AUTH_MODE=shim (the web is OIDC-only; the API
 * must validate the Bearer).
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

/** Idempotently wire apps/web/.env with the OIDC client id/secret + issuer. */
async function wireWebEnv(oidc: OidcClient): Promise<void> {
  const envPath = join(REPO_ROOT, "apps", "web", ".env");
  const examplePath = join(REPO_ROOT, "apps", "web", ".env.example");
  let text = await readOrSeedEnv(envPath, examplePath);
  text = setEnvKey(text, "AUTH_ISSUER", ZITADEL_URL);
  text = setEnvKey(text, "AUTH_CLIENT_ID", oidc.OIDC_CLIENT_ID);
  text = setEnvKey(text, "AUTH_CLIENT_SECRET", oidc.OIDC_CLIENT_SECRET);
  await Bun.write(envPath, text);
  log(`wired apps/web/.env (AUTH_ISSUER, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET).`);
}

/** Idempotently wire apps/api/.env: disable shim, set OIDC issuer/jwks + mgmt project + SA key path. */
async function wireApiEnv(oidc: OidcClient): Promise<void> {
  const envPath = join(REPO_ROOT, "apps", "api", ".env");
  const examplePath = join(REPO_ROOT, "apps", "api", ".env.example");
  let text = await readOrSeedEnv(envPath, examplePath);
  // The web is OIDC-only now, so the API must validate the Bearer — disable the shim.
  text = commentOutEnvKey(text, "AUTH_MODE");
  text = setEnvKey(text, "OIDC_ISSUER", ZITADEL_URL);
  // Zitadel serves keys at /oauth/v2/keys (NOT the derived /.well-known/jwks.json).
  text = setEnvKey(text, "OIDC_JWKS_URI", `${ZITADEL_URL}/oauth/v2/keys`);
  text = setEnvKey(text, "ZITADEL_MGMT_PROJECT_ID", oidc.ZITADEL_MGMT_PROJECT_ID);
  text = setEnvKey(text, "ZITADEL_MGMT_SA_KEY_PATH", SA_KEY_STASH_PATH);
  await Bun.write(envPath, text);
  log(`wired apps/api/.env (AUTH_MODE off, OIDC_ISSUER, OIDC_JWKS_URI, ZITADEL_MGMT_PROJECT_ID, ZITADEL_MGMT_SA_KEY_PATH).`);
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
  log("Zitadel is bootstrapped and the env files are wired. Next steps:");
  log(`  1. open ${WEB_ORIGIN}/setup  — create the first admin ONCE`);
  log(`  2. then ${WEB_ORIGIN}/login`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Mode orchestration.
// ---------------------------------------------------------------------------

async function runFresh(opts: Options): Promise<void> {
  log("MODE: --fresh (wipe dev state, rebuild from zero, bootstrap Zitadel, wire env)");

  // The reused bootstrap script needs these host tools (fail-loud if missing).
  await assertHostTools(["docker", "jq", "openssl", "curl"]);

  if (!opts.yes) await confirmFresh();

  // 1. Remove dev volumes.
  await wipeDevVolumes();

  // 2. Bring up backing services (compose.override.yaml chmods the secrets volume before Zitadel).
  await composeUp();

  // 3. Wait for db healthy AND Zitadel /debug/healthz 200.
  await waitForDbHealthy();
  await waitForZitadelHealthy();

  // 4. Prisma: migrate deploy + generate (explicit — #480) + seed.
  await prismaFresh();

  // 5. Bootstrap Zitadel (reuse the prod script) → returns the OIDC client config.
  const oidc = await bootstrapZitadel();

  // 6 (stash) + 7 + 8. Wire the env files idempotently. (stash happens inside bootstrapZitadel.)
  await wireWebEnv(oidc);
  await wireApiEnv(oidc);

  // 9. Print next steps, then start (unless --no-start).
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
  await waitForZitadelHealthy();
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
