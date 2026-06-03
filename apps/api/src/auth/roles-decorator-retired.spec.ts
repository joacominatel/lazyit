import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @Roles RETIREMENT guard (ADR-0046 P4). The legacy coarse `@Roles` decorator + `ROLES_KEY` and the
 * guard's dual-mode `@Roles` branch are GONE — the authorization guard is now the single
 * `@RequirePermission` primitive (@Public → @RequirePermission → open). This test fails CI if any of
 * those legacy artifacts creep back in, so the codebase can never regress to two enforcement paths.
 */
describe('@Roles legacy path is retired (ADR-0046 P4)', () => {
  const authDir = __dirname;

  it('the roles.decorator.ts file no longer exists', () => {
    expect(existsSync(join(authDir, 'roles.decorator.ts'))).toBe(false);
  });

  it('the authorization guard has no ROLES_KEY / @Roles branch', () => {
    const guard = readFileSync(join(authDir, 'roles.guard.ts'), 'utf8');
    expect(guard).not.toContain('ROLES_KEY');
    expect(guard).not.toContain('roles.decorator');
    // The only metadata gate the guard reads is the permission gate.
    expect(guard).toContain('PERMISSION_KEY');
  });

  it('no source file (outside docstrings) imports the retired decorator', () => {
    // A focused check: nothing under auth/ imports roles.decorator anymore. (The broader controller
    // sweep is covered by the parity test; this pins the guard + auth module specifically.)
    const guard = readFileSync(join(authDir, 'roles.guard.ts'), 'utf8');
    const module = readFileSync(join(authDir, 'auth.module.ts'), 'utf8');
    expect(guard).not.toMatch(/from '\.\/roles\.decorator'/);
    expect(module).not.toMatch(/from '\.\/roles\.decorator'/);
  });
});
