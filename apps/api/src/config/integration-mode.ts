import type { IntegrationMode } from '@lazyit/shared';

// Mirrors createIdentityProvider and never returns 'zitadel'; IDENTITY_PROVIDER_TYPE no longer changes the outcome (ADR-0102 §4).
export function resolveIntegrationMode(authMode?: string): IntegrationMode {
  return authMode?.trim().toLowerCase() === 'local' ? 'local' : 'generic-oidc';
}
