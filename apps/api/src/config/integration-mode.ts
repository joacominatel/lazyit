import type { IntegrationMode } from '@lazyit/shared';

// The single auth-mode read behind /config/status and the local-mode branches; IDENTITY_PROVIDER_TYPE is ignored (ADR-0102 §4).
export function resolveIntegrationMode(authMode?: string): IntegrationMode {
  return authMode?.trim().toLowerCase() === 'local' ? 'local' : 'generic-oidc';
}
