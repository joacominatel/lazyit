import { resolveServiceAccountPermissions } from './service-account-permissions';

// Service-account permission resolution (ADR-0048): the direct grants resolve to a clean catalog Set —
// catalog-foreign rows are ignored (a DB typo can never confer a power), and there is NO role / ADMIN
// short-circuit (a service account is fail-closed by construction).

describe('resolveServiceAccountPermissions', () => {
  it('keeps catalog literals and drops catalog-foreign rows', () => {
    const set = resolveServiceAccountPermissions([
      { permission: 'asset:read' },
      { permission: 'asset:write' },
      { permission: 'asset:superuser' }, // not in the catalog → ignored
      { permission: 'totally:bogus' }, // not in the catalog → ignored
    ]);
    expect(set.has('asset:read')).toBe(true);
    expect(set.has('asset:write')).toBe(true);
    expect(set.has('asset:superuser' as never)).toBe(false);
    expect(set.size).toBe(2);
  });

  it('returns an empty set for no grants (fail-closed: holds nothing)', () => {
    const set = resolveServiceAccountPermissions([]);
    expect(set.size).toBe(0);
  });

  it('has NO ADMIN / wildcard short-circuit — only the explicit grants are held', () => {
    const set = resolveServiceAccountPermissions([{ permission: 'asset:read' }]);
    // It holds exactly asset:read, nothing else — not user:manage, not settings:manage.
    expect(set.has('asset:read')).toBe(true);
    expect(set.has('user:manage')).toBe(false);
    expect(set.has('settings:manage')).toBe(false);
    expect(set.has('asset:delete')).toBe(false);
  });
});
