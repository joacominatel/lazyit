import { resolveIntegrationMode } from './integration-mode';

describe('resolveIntegrationMode', () => {
  it('reports generic-oidc for every non-local mode — never zitadel (ADR-0102 §4)', () => {
    expect(resolveIntegrationMode('oidc')).toBe('generic-oidc');
    expect(resolveIntegrationMode('shim')).toBe('generic-oidc');
    expect(resolveIntegrationMode(undefined)).toBe('generic-oidc');
  });

  it('returns local when AUTH_MODE=local (case/space-insensitive)', () => {
    expect(resolveIntegrationMode('local')).toBe('local');
    expect(resolveIntegrationMode('  LOCAL  ')).toBe('local');
  });
});
