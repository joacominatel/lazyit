/**
 * Resolve the JSON request-body limit (issue #1132). Nest-on-Express registers body-parser with
 * ITS OWN defaults unless told otherwise, and that default is 100kb — small enough to reject a
 * legitimate reporting-agent payload:
 *
 *   `AgentReportSchema` allows 5000 packages (packages/shared/src/schemas/infra.ts) and the
 *   collector caps at exactly that, so a fat RPM host or a desktop stack serializes to 140-230kb
 *   and POST /infra/report answers 413. The failure is silent AND misdiagnosed — install.sh
 *   reports "check the URL/token", so the operator debugs auth while the host never appears and
 *   the systemd timer retries the same 413 every 15 minutes, forever.
 *
 * The default below is deliberately generous relative to the largest legitimate report: the cap
 * that matters for abuse is the per-service-account rate limit (#1134) and the 5000-package
 * contract cap, not the transport limit. Lowering SOFTWARE_CAP to fit 100kb would have hidden the
 * bug class instead of closing it.
 *
 * Pure — kept out of main.ts (which drags the whole AppModule graph) so it unit-tests in isolation,
 * mirroring `parseTrustProxy` / `resolveCorsOrigin`.
 */

/** What Express/body-parser applies when nobody configures it — the source of #1132. */
export const EXPRESS_DEFAULT_JSON_BODY_LIMIT = '100kb';

/** lazyit's limit: ~35x the largest legitimate agent report, still far below a memory concern. */
export const DEFAULT_JSON_BODY_LIMIT = '8mb';

/**
 * A body-parser size string: digits (optionally fractional) followed by a unit. A bare number is
 * REJECTED on purpose — body-parser would read it as bytes, so a typo'd `JSON_BODY_LIMIT=8`
 * (meaning 8mb) would silently become 8 bytes and 413 every request. Fail closed to the default.
 */
const SIZE_PATTERN = /^\d+(\.\d+)?(b|kb|mb|gb)$/;

export function resolveJsonBodyLimit(env: NodeJS.ProcessEnv): string {
  const raw = env.JSON_BODY_LIMIT?.trim().toLowerCase();
  return raw && SIZE_PATTERN.test(raw) ? raw : DEFAULT_JSON_BODY_LIMIT;
}
