/**
 * Zero-touch bootstrap-file loader for the web (Auth.js) — ADR-0043 Phase 3.
 *
 * The `zitadel-bootstrap` sidecar GENERATES the OIDC client (id/secret), issuer and JWKS URI at first
 * boot and writes them to `oidc-client.json` in the shared `zitadel_secrets` volume (mounted
 * read-only into the web container). The operator cannot know those values in advance, so the
 * bundled-Zitadel flow must read them at runtime rather than from hand-copied AUTH_* env.
 *
 * This loader maps the file's OIDC_* keys onto the AUTH_* env vars `auth.ts` reads:
 *   OIDC_ISSUER        -> AUTH_ISSUER
 *   OIDC_CLIENT_ID     -> AUTH_CLIENT_ID
 *   OIDC_CLIENT_SECRET -> AUTH_CLIENT_SECRET
 *   origin(OIDC_JWKS_URI) -> AUTH_INTERNAL_ISSUER   (the internal Docker origin for server-side OIDC
 *                                                     calls — the sidecar's JWKS URI is the internal
 *                                                     Zitadel origin; see auth.ts AUTH_INTERNAL_ISSUER)
 * It only fills vars the operator did NOT set: explicit AUTH_* env ALWAYS wins (BYOI keeps working).
 *
 * RUNTIME SAFETY: `auth.ts` is imported by both the Node server (route handlers, server components)
 * AND the Edge middleware (proxy.ts). `node:fs` does not exist on the Edge runtime, so the file read
 * is confined to a branch gated on `process.env.NEXT_RUNTIME === "nodejs"`. Next.js statically
 * replaces NEXT_RUNTIME at build time, so in the Edge bundle this branch is dead-code-eliminated and
 * `node:fs` never enters that bundle. The Edge middleware only validates an existing session cookie —
 * it never needs the client secret — so the no-op on Edge is correct.
 *
 * BUILD SAFETY: `next build` runs with no mounted file; the read is wrapped in try/catch and an
 * absent file is the normal BYOI / env-only case (silent no-op). NEVER throws; NEVER logs secrets.
 */

/** Default path of the sidecar's OIDC client file inside the read-only `zitadel_secrets` mount. */
export const DEFAULT_OIDC_CLIENT_FILE = "/zitadel-secrets/oidc-client.json";

/** Set `key` on `process.env` only when it is not already a non-empty value (explicit env wins). */
function fillIfUnset(key: string, value: string | undefined): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const current = process.env[key];
  if (typeof current === "string" && current.trim().length > 0) return false;
  process.env[key] = value;
  return true;
}

/**
 * Read the bootstrap OIDC client file (path from `OIDC_CLIENT_FILE`, default
 * {@link DEFAULT_OIDC_CLIENT_FILE}) and back-fill the AUTH_* env vars `auth.ts` consumes for any the
 * operator did not set. Runs only on the Node runtime; a no-op on Edge and when the file is absent.
 * Returns the AUTH_* keys it filled (for logging/testing). NEVER throws; NEVER logs secret values.
 */
export function loadWebBootstrapOidcFile(): string[] {
  // Only the Node server has both `node:fs` and a need for the client secret (OIDC token exchange).
  // The Edge middleware bundle DCE's this branch (NEXT_RUNTIME is statically replaced), so `node:fs`
  // is never pulled into it.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") {
    return [];
  }

  const path =
    process.env.OIDC_CLIENT_FILE?.trim() || DEFAULT_OIDC_CLIENT_FILE;

  let raw: string;
  try {
    // Resolve `node:fs` through the runtime `process.getBuiltinModule` (Node 22+) instead of an
    // import/require. Auth.js is imported by BOTH the Node server and the Edge middleware (proxy.ts);
    // a static import of `node:fs` would break the Edge bundle, and a dynamic require makes Next's
    // file-tracer (NFT) trace the whole project into the standalone output. `getBuiltinModule` is a
    // pure runtime call the bundler does not follow, so neither happens. This branch is already gated
    // on NEXT_RUNTIME === "nodejs" above, where the builtin is always present.
    const fs = process.getBuiltinModule("node:fs");
    raw = fs.readFileSync(path, "utf8");
  } catch {
    // Absent file (the normal BYOI / build-time / env-only case) or no fs → silent no-op.
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.warn(
      `bootstrap OIDC file ${path} is not valid JSON; ignoring it (falling back to env).`,
    );
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  const asString = (k: string): string | undefined =>
    typeof parsed[k] === "string" ? (parsed[k] as string) : undefined;

  const filled: string[] = [];
  if (fillIfUnset("AUTH_ISSUER", asString("OIDC_ISSUER")))
    filled.push("AUTH_ISSUER");
  if (fillIfUnset("AUTH_CLIENT_ID", asString("OIDC_CLIENT_ID")))
    filled.push("AUTH_CLIENT_ID");
  if (fillIfUnset("AUTH_CLIENT_SECRET", asString("OIDC_CLIENT_SECRET")))
    filled.push("AUTH_CLIENT_SECRET");

  // The sidecar's OIDC_JWKS_URI is the INTERNAL Zitadel origin (e.g. http://zitadel:8080/oauth/v2/keys);
  // its origin is exactly what AUTH_INTERNAL_ISSUER needs (the Docker-internal base auth.ts rewrites
  // server-side OIDC calls to). Only derive it when the operator did not set AUTH_INTERNAL_ISSUER.
  const jwks = asString("OIDC_JWKS_URI");
  if (jwks) {
    try {
      const origin = new URL(jwks).origin;
      if (fillIfUnset("AUTH_INTERNAL_ISSUER", origin))
        filled.push("AUTH_INTERNAL_ISSUER");
    } catch {
      // Malformed JWKS URI in the file → skip the internal-issuer derivation (login still works if the
      // external issuer resolves inside the network).
    }
  }

  if (filled.length > 0) {
    // Log only the NAMES filled (never secret values) so the boot log shows the file took effect.
    console.warn(
      `bootstrap OIDC file ${path} supplied ${filled.length} unset AUTH var(s): ${filled.join(", ")}.`,
    );
  }
  return filled;
}
