import { readFileSync } from 'node:fs';

/**
 * Zero-touch bootstrap-file loader (ADR-0043 Phase 3).
 *
 * The `zitadel-bootstrap` sidecar GENERATES the OIDC client (id/secret), JWKS URI, issuer and the
 * lazyit project id at first boot and writes them to `oidc-client.json` inside the shared
 * `zitadel_secrets` volume (mounted read-only into api + web). The operator CANNOT know those values
 * in advance, so wiring them through static env defeats the zero-touch goal. This loader closes that
 * gap: at startup it reads the mounted file and back-fills `process.env` for any of those vars that
 * the operator did NOT already set. Every downstream consumer (the JwtAuthGuard, the
 * ZitadelManagementService) keeps reading `process.env.*` unchanged.
 *
 * PRECEDENCE: explicit env vars ALWAYS win. The file only fills the gaps. So:
 *   - BYOI (operator sets OIDC_* in env, no bundled Zitadel, file absent) → env-only path, untouched.
 *   - Bundled Zitadel zero-touch (OIDC_* unset, file present) → the file supplies them.
 *   - Mixed (operator pins some, e.g. OIDC_ISSUER, lets the sidecar supply the rest) → both honoured.
 *
 * FAIL-SOFT: a missing file is the normal BYOI / env-only case and is NOT an error — the loader
 * returns silently. A present-but-unreadable / malformed file logs a WARN (never the secret values)
 * and leaves env untouched, so a corrupt mount degrades to the env-only path rather than crashing.
 * This runs BEFORE validateBootConfig in main.ts, so the OIDC-mode boot validation sees the merged
 * env (the file's issuer/jwks satisfy the OIDC_ISSUER / OIDC_JWKS_URI requirements).
 *
 * Framework-free (no Nest) so it runs before NestFactory.create and unit-tests without booting.
 */

/** Default path of the sidecar's OIDC client file inside the read-only `zitadel_secrets` mount. */
export const DEFAULT_OIDC_CLIENT_FILE = '/zitadel-secrets/oidc-client.json';

/**
 * The keys the bootstrap sidecar writes into oidc-client.json (see infra/scripts/zitadel-bootstrap.sh
 * §3e) — exactly the env vars the api runtime reads. Only these are ever copied into `process.env`.
 */
const FILE_KEYS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_JWKS_URI',
  'ZITADEL_MGMT_PROJECT_ID',
] as const;

type FileKey = (typeof FILE_KEYS)[number];

/** Whether an env var is already set to a non-empty value (so the file must NOT override it). */
function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key];
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Load the bootstrap OIDC client file (path from `OIDC_CLIENT_FILE`, default
 * {@link DEFAULT_OIDC_CLIENT_FILE}) and back-fill `env` for any {@link FILE_KEYS} the operator did not
 * already set. Mutates `env` in place and returns the list of keys it filled (empty when the file is
 * absent or every value was already env-set). NEVER throws; NEVER logs secret values.
 *
 * @param env  the environment to merge into (defaults to `process.env`).
 * @param warn a sink for the single WARN emitted on a malformed/unreadable file (defaults to console).
 */
export function loadBootstrapOidcFile(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
): FileKey[] {
  const path = env.OIDC_CLIENT_FILE?.trim() || DEFAULT_OIDC_CLIENT_FILE;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Absent file = the normal BYOI / env-only case. Silent (no WARN, no throw).
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Present but unreadable → degrade to env-only, but make the misconfig visible (no secret leak).
    warn(
      `bootstrap OIDC file ${path} is not valid JSON; ignoring it (falling back to env). ` +
        `Re-bootstrap if this is the bundled-Zitadel flow.`,
    );
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn(
      `bootstrap OIDC file ${path} is not a JSON object; ignoring it (falling back to env).`,
    );
    return [];
  }

  const filled: FileKey[] = [];
  for (const key of FILE_KEYS) {
    if (isSet(env, key)) {
      // Explicit env wins — the file never overrides a value the operator pinned.
      continue;
    }
    const value = parsed[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      env[key] = value;
      filled.push(key);
    }
  }

  if (filled.length > 0) {
    // Log only the NAMES filled (never the secret values) so the boot log shows the file took effect.
    warn(
      `bootstrap OIDC file ${path} supplied ${filled.length} unset var(s): ${filled.join(', ')}.`,
    );
  }
  return filled;
}
