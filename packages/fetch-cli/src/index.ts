#!/usr/bin/env bun
/**
 * lazyit-fetch — a tiny, dependency-light headless CLI that pulls a vault's secrets over the lazyit API
 * using a SERVICE ACCOUNT token and decrypts them CLIENT-SIDE, then emits a `.env` (ADR-0080). The server
 * NEVER decrypts (INV-10): it returns ciphertext + the SA's wrapped keys; every unwrap happens here, in
 * `crypto.ts`, from the token.
 *
 * USAGE
 *   lazyit-fetch --vault <vaultId> [--api <url>] [--out .env] [--json]
 *   lazyit-fetch --list            [--api <url>]        # list the vaults this SA may fetch
 *   lazyit-fetch --self-check                           # run the built-in crypto round-trip and exit
 *
 * The SA token is read from the `LAZYIT_SA_TOKEN` env var (PREFERRED — keeps it out of `ps`/shell history)
 * or `--token <token>`. The API base URL is `--api` or `LAZYIT_API_URL` (e.g. http://localhost:3001). The
 * vault id is `--vault` or `LAZYIT_VAULT_ID`. Output defaults to stdout (`KEY=value` lines) so it composes
 * (`lazyit-fetch --vault v > .env`); `--out <path>` writes a file instead; `--json` emits `{handle: value}`.
 */

import {
  ServiceAccountVaultFetchSchema,
  SecretVaultSchema,
  type ServiceAccountVaultFetch,
} from "@lazyit/shared";
import { decryptVault, selfCheck } from "./crypto";

interface Args {
  token?: string;
  vault?: string;
  api?: string;
  out?: string;
  json: boolean;
  list: boolean;
  selfCheck: boolean;
  help: boolean;
}

/** Parse `--flag value` / `--bool` args. Unknown flags are an error (fail loud, ponytail-safe). */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    json: false,
    list: false,
    selfCheck: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--token":
        args.token = argv[++i];
        break;
      case "--vault":
        args.vault = argv[++i];
        break;
      case "--api":
        args.api = argv[++i];
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--json":
        args.json = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--self-check":
        args.selfCheck = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

const HELP = `lazyit-fetch — pull a vault's secrets and decrypt them locally (ADR-0080)

  lazyit-fetch --vault <vaultId> [--api <url>] [--out .env] [--json]
  lazyit-fetch --list            [--api <url>]
  lazyit-fetch --self-check

Auth:  LAZYIT_SA_TOKEN env (preferred) or --token <token>
Api:   --api <url> or LAZYIT_API_URL (e.g. http://localhost:3001)
Vault: --vault <id> or LAZYIT_VAULT_ID
Out:   stdout by default (KEY=value); --out <path> writes a file; --json emits {handle: value}`;

/** Uppercase + non-word→`_` so a handle is a valid shell/.env identifier. Documented in the Manual. */
function toEnvKey(handle: string): string {
  return handle.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** Quote + escape a value for a `.env` line (dotenv-style: backslash, double-quote, newline). */
function toEnvValue(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

function renderEnv(secrets: Record<string, string>): string {
  return (
    Object.entries(secrets)
      .map(([handle, value]) => `${toEnvKey(handle)}=${toEnvValue(value)}`)
      .join("\n") + "\n"
  );
}

/** Resolve the required config from flags + env, or exit with a clear message. */
function resolveConfig(args: Args): { token: string; api: string } {
  const token = args.token ?? process.env.LAZYIT_SA_TOKEN;
  const api = (args.api ?? process.env.LAZYIT_API_URL ?? "").replace(
    /\/+$/,
    "",
  );
  if (!token) {
    fail(
      "Missing service-account token. Set LAZYIT_SA_TOKEN (preferred) or pass --token.",
    );
  }
  if (!api) {
    fail("Missing API base URL. Set LAZYIT_API_URL or pass --api <url>.");
  }
  return { token, api };
}

function fail(message: string): never {
  process.stderr.write(`lazyit-fetch: ${message}\n`);
  process.exit(1);
}

/** GET a lazyit endpoint with the SA bearer token; throws a clear message on a non-2xx. */
async function apiGet(
  api: string,
  path: string,
  token: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${api}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (err) {
    return fail(
      `could not reach the API at ${api} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    const detail =
      res.status === 401 || res.status === 403
        ? " (check the token + that the SA is a member of the vault)"
        : "";
    return fail(`API returned ${res.status} ${res.statusText}${detail}`);
  }
  return res.json();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  // Self-check needs no server, no token — it proves the crypto chain locally.
  if (args.selfCheck) {
    await selfCheck();
    process.stdout.write(
      "lazyit-fetch self-check: OK (crypto round-trip passed)\n",
    );
    return;
  }

  const { token, api } = resolveConfig(args);

  // List the vaults this SA may fetch (discovery).
  if (args.list) {
    const raw = await apiGet(api, "/secret-fetch", token);
    const vaults = SecretVaultSchema.array().parse(raw);
    for (const v of vaults) {
      process.stdout.write(`${v.id}\t${v.name}\n`);
    }
    return;
  }

  const vault = args.vault ?? process.env.LAZYIT_VAULT_ID;
  if (!vault) {
    fail(
      "Missing vault id. Pass --vault <id> or set LAZYIT_VAULT_ID (or use --list).",
    );
  }

  const raw = await apiGet(api, `/secret-fetch/${vault}`, token);
  let fetched: ServiceAccountVaultFetch;
  try {
    fetched = ServiceAccountVaultFetchSchema.parse(raw);
  } catch {
    return fail("the API response did not match the expected fetch shape");
  }

  let secrets: Record<string, string>;
  try {
    secrets = await decryptVault(token, fetched);
  } catch {
    // The generic, payload-free decrypt error (INV-10) — never leak key/plaintext detail.
    return fail(
      "decryption failed (wrong token, tampered data, or this SA cannot read this vault)",
    );
  }

  const output = args.json
    ? JSON.stringify(secrets, null, 2) + "\n"
    : renderEnv(secrets);

  if (args.out) {
    await Bun.write(args.out, output);
    process.stderr.write(
      `lazyit-fetch: wrote ${Object.keys(secrets).length} secret(s) to ${args.out}\n`,
    );
  } else {
    process.stdout.write(output);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
