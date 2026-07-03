import type { IntegrationMode } from '@lazyit/shared';

/**
 * The default IdP posture when `IDENTITY_PROVIDER_TYPE` is unset/unrecognized: zitadel, lazyit's
 * recommended self-hosted IdP. This MUST stay in sync with
 * `DEFAULT_IDENTITY_PROVIDER_TYPE` in auth/identity/identity-provider.factory.ts — it is duplicated
 * here (not imported) on purpose, so this tiny env-parsing helper does not drag the whole IdP module
 * graph (Zitadel adapter → `jose`, ESM) into a unit that only reads a string.
 */
const DEFAULT_INTEGRATION_MODE: IntegrationMode = 'zitadel';

/**
 * Resolve the wizard's `integrationMode` from `AUTH_MODE` + `IDENTITY_PROVIDER_TYPE` (ADR-0043 §5a /
 * ADR-0086 §5).
 *
 * `AUTH_MODE=local` takes precedence and yields `'local'` regardless of IDENTITY_PROVIDER_TYPE — local
 * mode has no external IdP (it mirrors the {@link createIdentityProvider} factory, which builds the
 * LocalIdentityProvider in that case). Otherwise this mirrors the factory's IDENTITY_PROVIDER_TYPE parse
 * (trim + lowercase, default = zitadel) so the value `GET /config/status` reports always matches the IdP
 * the AuthModule actually built. Kept pure (takes the raw values) so it is unit-testable without DI.
 */
export function resolveIntegrationMode(
  rawType?: string,
  authMode?: string,
): IntegrationMode {
  if (authMode?.trim().toLowerCase() === 'local') {
    return 'local';
  }
  const type = rawType?.trim().toLowerCase();
  if (type === 'generic-oidc') {
    return 'generic-oidc';
  }
  if (type === 'zitadel') {
    return 'zitadel';
  }
  return DEFAULT_INTEGRATION_MODE;
}
