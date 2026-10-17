#!/usr/bin/env bun
// Fills a lazyit instance with high-volume mock data through its REST API. See docs/04-development/demo-data.md.
import type { InstanceVersion, SmtpSettings, User, UserSessionList } from "@lazyit/shared";
import { ApiError, Client, login } from "./lib/api";
import { type Ctx, PROFILES, TAXA, type Taxa, type TaxonKey, VOLUME_KEYS, type VolumeKey, type Volumes } from "./lib/context";
import { PhaseFailedError, Report } from "./lib/report";
import { jitter } from "./lib/rng";
import { GRANT_ENTITIES, REQUEST_ENTITIES, runGrants, runRequests } from "./phases/access";
import { runApplications } from "./phases/applications";
import { ASSET_ENTITIES, runAssets } from "./phases/assets";
import { CONSUMABLE_ENTITIES, runConsumables } from "./phases/consumables";
import { printInventory } from "./phases/inventory";
import { KB_ENTITIES, runKnowledgeBase } from "./phases/kb";
import { PURCHASE_ENTITIES, runPurchases } from "./phases/purchases";
import { locationPlan, runTaxonomy, TAXONOMY_ENTITIES } from "./phases/taxonomy";
import { planUsers, runOffboarding, runUsers, USER_ENTITIES } from "./phases/users";

const HELP = `Fill a lazyit instance with realistic, high-volume mock data through its REST API.

Usage: bun scripts/demo-data/seed.ts [flags]

Environment:
  LAZYIT_URL        API base URL. Deployed instance: https://<host>/api (or http://<host>/api
                    on a LAN install). Local dev API: http://localhost:3001
  LAZYIT_EMAIL      Email (or username) of an ADMIN account
  LAZYIT_PASSWORD   Its password. Never printed.

Flags:
  --profile <full|small>  Volume profile (default: full). small is about 5% of full.
  --seed <text>           Seed for every generated value (default: lazyit-demo). The same seed
                          always produces the same records and the same target counts.
  --count <key>=<n>       Exact target for one volume, repeatable. Keys: ${VOLUME_KEYS.join(", ")}.
  --concurrency <n>       Parallel requests (default: 8).
  --allow-email           Run even though outbound email (SMTP) is enabled on the instance.
  --yes, -y               Skip the typed "yes" confirmation.
  --inventory             Print the read-only inventory of the instance and exit (no writes).
  --help, -h              Show this help.

Re-running is safe: records that already exist (matched by email, serial, name, SKU, purchase
reference or slug) are skipped, so an interrupted run resumes where it stopped.
Exit code: 0 when every row succeeded, 2 when some rows failed, 1 when the run stopped.`;

interface Options {
  profile: "full" | "small";
  seed: string;
  counts: Partial<Volumes>;
  concurrency: number;
  allowEmail: boolean;
  yes: boolean;
  inventory: boolean;
}

function fail(message: string): never {
  console.error(`demo-data: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { profile: "full", seed: "lazyit-demo", counts: {}, concurrency: 8, allowEmail: false, yes: false, inventory: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    switch (arg) {
      case "--help":
      case "-h":
        console.log(HELP);
        process.exit(0);
        break;
      case "--profile": {
        const profile = value();
        if (profile !== "full" && profile !== "small") fail("--profile must be full or small");
        opts.profile = profile;
        break;
      }
      case "--seed":
        opts.seed = value();
        break;
      case "--count": {
        const [key, raw] = value().split("=");
        const n = Number(raw);
        if (!VOLUME_KEYS.includes(key as VolumeKey) || !Number.isInteger(n) || n < 0) {
          fail(`--count takes <key>=<n> with key one of ${VOLUME_KEYS.join(", ")}`);
        }
        opts.counts[key as VolumeKey] = n;
        break;
      }
      case "--concurrency": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 64) fail("--concurrency must be 1-64");
        opts.concurrency = n;
        break;
      }
      case "--allow-email":
        opts.allowEmail = true;
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--inventory":
        opts.inventory = true;
        break;
      default:
        fail(`unknown argument ${arg} (see --help)`);
    }
  }
  return opts;
}

function resolveCounts(opts: Options): { volumes: Volumes; taxa: Taxa } {
  const nominal = PROFILES[opts.profile];
  const volumes = Object.fromEntries(
    VOLUME_KEYS.map((k) => [k, opts.counts[k] ?? jitter(opts.seed, `${opts.profile}:${k}`, nominal[k])]),
  ) as Volumes;
  const taxa = Object.fromEntries(
    (Object.keys(TAXA) as TaxonKey[]).map((k) => [k, jitter(opts.seed, k, TAXA[k].nominal, TAXA[k].max)]),
  ) as Taxa;
  return { volumes, taxa };
}

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const base = (process.env.LAZYIT_URL ?? "").trim().replace(/\/+$/, "");
  const email = process.env.LAZYIT_EMAIL?.trim();
  const password = process.env.LAZYIT_PASSWORD;
  if (!base || !email || !password) fail("set LAZYIT_URL, LAZYIT_EMAIL and LAZYIT_PASSWORD (see --help)");
  if (!/^https?:\/\//.test(base)) fail("LAZYIT_URL must start with http:// or https://");

  const session = await login(new Client(base), email, password).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) fail("sign-in refused: check LAZYIT_EMAIL and LAZYIT_PASSWORD (local accounts only)");
    if (err instanceof ApiError && err.status === 404) fail("POST /auth/login not found: LAZYIT_URL must be the API base, e.g. https://<host>/api");
    fail(`sign-in failed: ${(err as Error).message}`);
  });
  const api = new Client(base, session.token);
  const me = await api.get<User>("/users/me");
  if (me.role !== "ADMIN") fail(`${me.email} is ${me.role}; the generator needs an ADMIN account`);

  if (opts.inventory) {
    await printInventory(api);
    await endSession(api);
    return;
  }

  const smtp = await api.get<SmtpSettings>("/config/smtp");
  if (smtp.enabled && !opts.allowEmail) {
    fail(
      "outbound email (SMTP) is enabled on this instance. The generator triggers notification emails " +
        "(critical-app and admin-level grants, low stock, expiring warranties and grants to admins; access-request " +
        "decisions to the mock .test addresses). Turn email off in Settings → Email, or pass --allow-email " +
        "to accept them.",
    );
  }
  const version = await api.get<InstanceVersion>("/instance/version");
  const { volumes, taxa } = resolveCounts(opts);
  const locations = locationPlan(opts.seed).length;

  console.log(`Target      ${base}`);
  console.log(`Instance    lazyit ${version.current} (${version.gitSha})`);
  console.log(`Signed in   ${me.email} (ADMIN)`);
  console.log(`Outbound    SMTP ${smtp.enabled ? "ENABLED: emails will be sent" : "disabled"}`);
  console.log(`Profile     ${opts.profile}, seed "${opts.seed}", concurrency ${opts.concurrency}`);
  console.log(
    `Volumes     users ${volumes.users}, assets ${volumes.assets}, access grants ${volumes.grants}, ` +
      `access requesters ${volumes.requesters}, purchases ${volumes.purchases}, KB articles ${volumes.articles}`,
  );
  console.log(
    `Catalogs    applications ${taxa.applications}, suppliers ${taxa.suppliers}, status labels ${taxa.statusLabels}, ` +
      `asset models ${taxa.assetModels}, consumables ${taxa.consumables}, KB folders ${taxa.folders}, locations ${locations}`,
  );
  console.log("Mock data cannot be deleted afterwards (lazyit never hard-deletes). Take a backup first.");
  if (!opts.yes) {
    if (!process.stdin.isTTY) fail("not a terminal: pass --yes to confirm");
    const answer = prompt('Type "yes" to write to this instance:');
    if (answer?.trim() !== "yes") fail("aborted");
  }

  const report = new Report();
  const ctx: Ctx = {
    api,
    seed: opts.seed,
    concurrency: opts.concurrency,
    volumes,
    taxa,
    report,
    me,
    assetCategories: new Map(),
    applicationCategories: new Map(),
    consumableCategories: new Map(),
    locations: new Map(),
    models: new Map(),
    labels: new Map(),
    suppliers: new Map(),
    applications: new Map(),
    users: [],
    assets: new Map(),
    consumables: new Map(),
  };
  process.on("SIGINT", () => {
    console.log("\nInterrupted. Run the same command again to resume.");
    report.print();
    process.exit(130);
  });

  const users = planUsers(opts.seed, volumes.users, volumes.requesters);
  try {
    await report.phase("Taxonomies", TAXONOMY_ENTITIES, () => runTaxonomy(ctx));
    await report.phase("Applications", ["application"], () => runApplications(ctx));
    await report.phase("Users", USER_ENTITIES, () => runUsers(ctx, users));
    await report.phase("Assets and assignments", ASSET_ENTITIES, () => runAssets(ctx));
    await report.phase("Access grants", GRANT_ENTITIES, () => runGrants(ctx));
    await report.phase("Access requests", REQUEST_ENTITIES, () => runRequests(ctx, users));
    await report.phase("Consumables", CONSUMABLE_ENTITIES, () => runConsumables(ctx));
    await report.phase("Purchases", PURCHASE_ENTITIES, () => runPurchases(ctx));
    await report.phase("Knowledge base", KB_ENTITIES, () => runKnowledgeBase(ctx));
    await report.phase("Offboarding", ["user offboarding"], () => runOffboarding(ctx, users));
  } catch (err) {
    report.print();
    if (err instanceof PhaseFailedError) fail(err.message);
    throw err;
  }
  report.print();
  await printInventory(api);
  await endSession(api);
  if (report.failureCount > 0) process.exit(2);
}

// Ends only this script's session: POST /auth/logout would sign the admin out of every device.
async function endSession(api: Client): Promise<void> {
  try {
    const { sessions } = await api.get<UserSessionList>("/auth/sessions");
    const current = sessions.find((s) => s.current);
    if (current) await api.delete(`/auth/sessions/${current.id}`);
  } catch {
    // Best effort: the session expires on its own after 12 hours.
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
