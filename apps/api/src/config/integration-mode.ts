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
 * Resolve the wizard's `integrationMode` from the `IDENTITY_PROVIDER_TYPE` env var (ADR-0043 §5a).
 *
 * Mirrors the {@link createIdentityProvider} factory's parsing (trim + lowercase, default = zitadel)
 * so the value `GET /config/status` reports always matches the IdP the AuthModule actually built — an
 * unrecognized/unset value falls back to the same Zitadel default. Kept pure (takes the raw value) so
 * it is unit-testable without DI and reused by the ConfigService.
 */
export function resolveIntegrationMode(rawType?: string): IntegrationMode {
  const type = rawType?.trim().toLowerCase();
  if (type === 'generic-oidc') {
    return 'generic-oidc';
  }
  if (type === 'zitadel') {
    return 'zitadel';
  }
  return DEFAULT_INTEGRATION_MODE;
}
