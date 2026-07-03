import { resolveIntegrationMode } from './integration-mode';

describe('resolveIntegrationMode', () => {
  it('maps explicit values (case/space-insensitive)', () => {
    expect(resolveIntegrationMode('zitadel')).toBe('zitadel');
    expect(resolveIntegrationMode('generic-oidc')).toBe('generic-oidc');
    expect(resolveIntegrationMode('  Generic-OIDC  ')).toBe('generic-oidc');
    expect(resolveIntegrationMode('ZITADEL')).toBe('zitadel');
  });

  it('falls back to the zitadel default when unset or unrecognized', () => {
    expect(resolveIntegrationMode(undefined)).toBe('zitadel');
    expect(resolveIntegrationMode('')).toBe('zitadel');
    expect(resolveIntegrationMode('okta')).toBe('zitadel');
  });

  // ADR-0086 §5 (F1c): AUTH_MODE=local yields 'local' regardless of IDENTITY_PROVIDER_TYPE.
  it('returns local when AUTH_MODE=local (case/space-insensitive), ignoring the IdP type', () => {
    expect(resolveIntegrationMode(undefined, 'local')).toBe('local');
    expect(resolveIntegrationMode('zitadel', 'local')).toBe('local');
    expect(resolveIntegrationMode('generic-oidc', 'local')).toBe('local');
    expect(resolveIntegrationMode('zitadel', '  LOCAL  ')).toBe('local');
  });

  it('keeps the IDENTITY_PROVIDER_TYPE parse for non-local AUTH_MODE values', () => {
    expect(resolveIntegrationMode('generic-oidc', 'oidc')).toBe('generic-oidc');
    expect(resolveIntegrationMode('zitadel', 'shim')).toBe('zitadel');
    expect(resolveIntegrationMode(undefined, 'oidc')).toBe('zitadel');
  });
});
