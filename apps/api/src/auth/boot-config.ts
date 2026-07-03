import { z } from 'zod';

/**
 * Fail-loud boot config (ops-boot integrity). Validated with zod BEFORE NestFactory.create (in
 * main.ts) so a misconfigured server refuses to start with a CRITICAL log listing every bad var,
 * instead of booting half-wired and 401/500-ing at runtime.
 *
 * Branches on AUTH_MODE, now a THREE-state enum (`shim` | `local` | `oidc`, ADR-0086): `oidc` requires
 * OIDC_ISSUER + OIDC_JWKS_URI; `local` requires a length-asserted SESSION_SIGNING_SECRET; `shim` requires
 * neither (dev X-User-Id bypass). DATABASE_URL is always required. MEILI_HOST / MAX_IMPORT_SIZE_MB stay
 * optional so the committed example .env still boots (search is fail-soft — ADR-0035).
 *
 * Hard safeguards that live here:
 *  - AUTH_MODE is EXPLICIT-REQUIRED (ADR-0086 §2). An UNSET value used to imply OIDC via an else-branch;
 *    with a third mode that silent default would flip every existing OIDC deploy to `local` on the next
 *    boot → a full outage. So unset is now a hard boot failure with a clear "set AUTH_MODE=oidc" message.
 *  - AUTH_MODE=shim is REFUSED when NODE_ENV=production (one stray env var would otherwise fully
 *    disable auth on a prod server holding access-grant data).
 *  - AUTH_MODE=local REQUIRES SESSION_SIGNING_SECRET (present + ≥32 chars) — a misconfigured local deploy
 *    must fail at BOOT, not on the first login (mirrors the WORKFLOW_SECRET_KEY length assertion).
 *  - WEB_ORIGIN, when set, must be a valid URL (it feeds CORS with credentials:true, where the
 *    origin can never be "*").
 *
 * The persisted mode-marker check (ADR-0086 §1 — refuse to boot when env.AUTH_MODE disagrees with the
 * stored marker) is NOT here: it needs the DB, so it runs after NestFactory.create (see auth/mode-marker.ts
 * + main.ts). This file stays framework-free (no Nest) so it validates and unit-tests without booting.
 */
const urlMessage = 'must be an absolute URL (e.g. https://auth.example.com)';

export const BootConfigSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    // Kept `.optional()` at the field level so an INVALID value ('foo') still yields a clean enum error;
    // an UNSET value passes the field but is rejected by the explicit-required refine below (ADR-0086 §2).
    AUTH_MODE: z.enum(['shim', 'local', 'oidc']).optional(),
    DATABASE_URL: z.string().min(1, 'is required'),
    WEB_ORIGIN: z.url(urlMessage).optional(),
    OIDC_ISSUER: z.url(urlMessage).optional(),
    OIDC_JWKS_URI: z.url(urlMessage).optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    // Persistent HMAC key for the first-party local session token (ADR-0086 §4). Required ONLY in local
    // mode (asserted below); distinct from AUTH_SECRET (Auth.js cookie key). Optional here so the other
    // modes still boot without it.
    SESSION_SIGNING_SECRET: z.string().optional(),
    // Optional so the example .env still boots (ADR-0035 fail-soft search; import-size guard).
    MEILI_HOST: z.url(urlMessage).optional(),
    MAX_IMPORT_SIZE_MB: z.coerce.number().positive().optional(),
  })
  // AUTH_MODE is EXPLICIT-REQUIRED once the third mode exists (ADR-0086 §2): unset no longer implies OIDC.
  .refine((c) => c.AUTH_MODE !== undefined, {
    message:
      'AUTH_MODE must be explicitly one of shim|local|oidc; unset previously meant oidc and is no longer safe — set AUTH_MODE=oidc to keep OIDC',
    path: ['AUTH_MODE'],
  })
  // Shim is a dev/test-only escape hatch — never let it ship to production.
  .refine((c) => !(c.AUTH_MODE === 'shim' && c.NODE_ENV === 'production'), {
    message:
      'AUTH_MODE=shim is forbidden when NODE_ENV=production (it disables authentication). Use local or oidc in production.',
    path: ['AUTH_MODE'],
  })
  // Local mode needs a persistent signing secret for the session token; length-asserted like
  // WORKFLOW_SECRET_KEY so a too-short/absent secret fails at boot, not on the first login (ADR-0086 §4).
  .refine(
    (c) =>
      c.AUTH_MODE !== 'local' ||
      (!!c.SESSION_SIGNING_SECRET && c.SESSION_SIGNING_SECRET.length >= 32),
    {
      message:
        'is required in local mode (AUTH_MODE=local) and must be at least 32 characters (generate with: openssl rand -hex 32)',
      path: ['SESSION_SIGNING_SECRET'],
    },
  )
  // OIDC mode needs an issuer and a JWKS URI to verify tokens; without them every request would 401.
  .refine((c) => c.AUTH_MODE !== 'oidc' || !!c.OIDC_ISSUER, {
    message: 'is required in OIDC mode (AUTH_MODE=oidc)',
    path: ['OIDC_ISSUER'],
  })
  .refine((c) => c.AUTH_MODE !== 'oidc' || !!c.OIDC_JWKS_URI, {
    message: 'is required in OIDC mode (AUTH_MODE=oidc)',
    path: ['OIDC_JWKS_URI'],
  });

export type BootConfig = z.infer<typeof BootConfigSchema>;

/**
 * Validate `env` against {@link BootConfigSchema}; on failure, print a CRITICAL log naming every
 * offending var and `process.exit(1)`. Returns the parsed config on success.
 */
export function validateBootConfig(
  env: NodeJS.ProcessEnv = process.env,
): BootConfig {
  const result = BootConfigSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // console.error: this runs before the Nest/Pino logger exists.
  console.error(
    `CRITICAL: invalid boot configuration — refusing to start.\n${issues}`,
  );
  process.exit(1);
}
