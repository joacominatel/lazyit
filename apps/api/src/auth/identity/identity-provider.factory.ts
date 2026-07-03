import { Logger } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import type { IdentityProvider } from './identity-provider.interface';
import { GenericOidcIdentityProvider } from './generic-oidc.identity-provider';
import { LocalIdentityProvider } from './local.identity-provider';
import { ZitadelIdentityProvider } from './zitadel.identity-provider';

/** Recognized values for the IDENTITY_PROVIDER_TYPE env var (ADR-0043). */
export type IdentityProviderType = 'zitadel' | 'generic-oidc';

/** Default when IDENTITY_PROVIDER_TYPE is unset: Zitadel is lazyit's recommended self-hosted IdP. */
export const DEFAULT_IDENTITY_PROVIDER_TYPE: IdentityProviderType = 'zitadel';

/**
 * Resolve which IdP implementation to use (ADR-0043 / ADR-0086 §5).
 *
 * AUTH_MODE takes precedence: when `AUTH_MODE=local`, the provider is ALWAYS the pure-no-op
 * {@link LocalIdentityProvider} (`kind='local'`, `supportsManagement=false`) regardless of
 * IDENTITY_PROVIDER_TYPE — local mode has no external IdP to mirror to, and this is the signal the
 * Users/Config services branch on to take the local-credential path. Otherwise (shim/oidc) the choice is
 * the existing IDENTITY_PROVIDER_TYPE parse: trimmed + lowercased; unset/unrecognized falls back to the
 * Zitadel default with a warn. Kept pure (takes the raw values, returns the constructed provider) so it is
 * unit-testable without DI.
 *
 * `requestLogger` is the request-scoped {@link PinoLogger} the auth module injects (issue #219); it is
 * threaded into the Zitadel provider so its management WARN lines carry the failing edit's
 * `X-Request-Id` / `actor` (ADR-0031). It is optional so the factory stays unit-testable with a plain
 * `createIdentityProvider('zitadel')` call (no DI), and the local/generic-oidc no-op paths ignore it.
 */
export function createIdentityProvider(
  rawType?: string,
  requestLogger: PinoLogger | null = null,
  authMode?: string,
): IdentityProvider {
  const logger = new Logger('IdentityProviderFactory');

  // AUTH_MODE=local wins over IDENTITY_PROVIDER_TYPE: no external IdP exists to mirror to (ADR-0086 §5).
  if (authMode?.trim().toLowerCase() === 'local') {
    logger.log('IdentityProvider: local (AUTH_MODE=local; no IdP, pure no-op)');
    return new LocalIdentityProvider();
  }

  const type = rawType?.trim().toLowerCase();

  switch (type) {
    case 'generic-oidc':
      logger.log('IdentityProvider: generic-oidc (BYOI; management is no-op)');
      return new GenericOidcIdentityProvider();
    case 'zitadel':
      logger.log('IdentityProvider: zitadel (management write-back, Phase 2)');
      return new ZitadelIdentityProvider(requestLogger);
    default:
      if (type) {
        logger.warn(
          `Unknown IDENTITY_PROVIDER_TYPE="${rawType}"; falling back to "${DEFAULT_IDENTITY_PROVIDER_TYPE}"`,
        );
      }
      return new ZitadelIdentityProvider(requestLogger);
  }
}
