import { Logger } from '@nestjs/common';
import type { IdentityProvider } from './identity-provider.interface';
import { GenericOidcIdentityProvider } from './generic-oidc.identity-provider';
import { LocalIdentityProvider } from './local.identity-provider';

// IDENTITY_PROVIDER_TYPE only warns now: a legacy or unknown value must never change the IdP or fail boot (ADR-0102 §4).
export function createIdentityProvider(
  rawType?: string,
  authMode?: string,
): IdentityProvider {
  const logger = new Logger('IdentityProviderFactory');

  if (authMode?.trim().toLowerCase() === 'local') {
    logger.log('IdentityProvider: local (AUTH_MODE=local; no IdP, pure no-op)');
    return new LocalIdentityProvider();
  }

  const type = rawType?.trim().toLowerCase();
  if (type === 'zitadel') {
    logger.warn(
      'IDENTITY_PROVIDER_TYPE=zitadel is no longer supported (the bundled Zitadel was removed, ADR-0102); using generic-oidc. Remove the variable to silence this warning.',
    );
  } else if (type && type !== 'generic-oidc') {
    logger.warn(
      `Unknown IDENTITY_PROVIDER_TYPE="${rawType}"; using generic-oidc`,
    );
  }
  logger.log('IdentityProvider: generic-oidc (management is no-op)');
  return new GenericOidcIdentityProvider();
}
