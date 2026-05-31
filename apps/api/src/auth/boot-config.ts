import { z } from 'zod';

/**
 * Fail-loud boot config (ops-boot integrity). Validated with zod BEFORE NestFactory.create (in
 * main.ts) so a misconfigured server refuses to start with a CRITICAL log listing every bad var,
 * instead of booting half-wired and 401/500-ing at runtime.
 *
 * Branches on AUTH_MODE: OIDC mode (the production default — anything other than "shim")
 * additionally requires OIDC_ISSUER + OIDC_JWKS_URI. DATABASE_URL is always required.
 * MEILI_HOST / MAX_IMPORT_SIZE_MB stay optional so the committed example .env still boots
 * (search is fail-soft — ADR-0035).
 *
 * Two hard safeguards live here:
 *  - AUTH_MODE=shim is REFUSED when NODE_ENV=production (one stray env var would otherwise fully
 *    disable auth on a prod server holding access-grant data).
 *  - WEB_ORIGIN, when set, must be a valid URL (it feeds CORS with credentials:true, where the
 *    origin can never be "*").
 *
 * Lives under auth/ because AUTH_MODE + OIDC dominate it and it is the auth boundary's startup
 * contract; kept framework-free (no Nest) so it validates and unit-tests without booting the app.
 */
const urlMessage = 'must be an absolute URL (e.g. https://auth.example.com)';

export const BootConfigSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    AUTH_MODE: z.enum(['shim', 'oidc']).optional(),
    DATABASE_URL: z.string().min(1, 'is required'),
    WEB_ORIGIN: z.url(urlMessage).optional(),
    OIDC_ISSUER: z.url(urlMessage).optional(),
    OIDC_JWKS_URI: z.url(urlMessage).optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    // Optional so the example .env still boots (ADR-0035 fail-soft search; import-size guard).
    MEILI_HOST: z.url(urlMessage).optional(),
    MAX_IMPORT_SIZE_MB: z.coerce.number().positive().optional(),
  })
  // Shim is a dev/test-only escape hatch — never let it ship to production.
  .refine((c) => !(c.AUTH_MODE === 'shim' && c.NODE_ENV === 'production'), {
    message:
      'AUTH_MODE=shim is forbidden when NODE_ENV=production (it disables authentication). Use OIDC in production.',
    path: ['AUTH_MODE'],
  })
  // OIDC mode (the default when AUTH_MODE is not "shim") needs an issuer and a JWKS URI to verify
  // tokens; without them every request would 401 at runtime.
  .refine((c) => c.AUTH_MODE === 'shim' || !!c.OIDC_ISSUER, {
    message: 'is required in OIDC mode (AUTH_MODE is not "shim")',
    path: ['OIDC_ISSUER'],
  })
  .refine((c) => c.AUTH_MODE === 'shim' || !!c.OIDC_JWKS_URI, {
    message: 'is required in OIDC mode (AUTH_MODE is not "shim")',
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
