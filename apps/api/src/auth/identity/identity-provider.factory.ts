import { Logger } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import type { IdentityProvider } from './identity-provider.interface';
import { GenericOidcIdentityProvider } from './generic-oidc.identity-provider';
import { ZitadelIdentityProvider } from './zitadel.identity-provider';

/** Recognized values for the IDENTITY_PROVIDER_TYPE env var (ADR-0043). */
export type IdentityProviderType = 'zitadel' | 'generic-oidc';

/** Default when IDENTITY_PROVIDER_TYPE is unset: Zitadel is lazyit's recommended self-hosted IdP. */
export const DEFAULT_IDENTITY_PROVIDER_TYPE: IdentityProviderType = 'zitadel';

/**
 * Resolve which IdP implementation to use from the IDENTITY_PROVIDER_TYPE env var (ADR-0043). The
 * value is trimmed + lowercased; unset or unrecognized falls back to the Zitadel default with a warn.
 * Kept pure (takes the raw value, returns the constructed provider) so it is unit-testable without DI.
 *
 * `requestLogger` is the request-scoped {@link PinoLogger} the auth module injects (issue #219); it is
 * threaded into the Zitadel provider so its management WARN lines carry the failing edit's
 * `X-Request-Id` / `actor` (ADR-0031). It is optional so the factory stays unit-testable with a plain
 * `createIdentityProvider('zitadel')` call (no DI), and the generic-oidc/no-op path ignores it.
 */
export function createIdentityProvider(
  rawType?: string,
  requestLogger: PinoLogger | null = null,
): IdentityProvider {
  const logger = new Logger('IdentityProviderFactory');
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
