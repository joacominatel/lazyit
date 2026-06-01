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
});
