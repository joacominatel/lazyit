import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  type Permission,
  type Role,
  type RolePermissionMatrix,
} from '@lazyit/shared';

/**
 * GOLDEN matrix test (Roles & Permissions v2 — ADR-0046, P1). The Prisma seed inserts the
 * `RolePermission` rows from `DEFAULT_ROLE_PERMISSIONS` (the shared single source of truth). This test
 * pins that matrix to a SECOND, independently-constructed expectation derived here from first
 * principles (the ADR-0040 capability tiers + the CEO read pre-tightening). If the seed source ever
 * drifts from the documented intent, the two disagree and CI fails — a wrong seed cannot ship.
 *
 * It deliberately re-derives the expectation a DIFFERENT way than `DEFAULT_ROLE_PERMISSIONS` does
 * (explicit tier rules, not a filter pipeline) so a bug in the shared builder can't hide behind an
 * identical implementation. No DB is touched — both sides are pure data.
 */

// ── The DOCUMENTED matrix, reconstructed from the ADR rules (the "golden" expectation) ──────────────

/** Split the frozen catalog by action suffix, independently of the shared helpers. */
const readPerms = PERMISSIONS.filter((p) => p.endsWith(':read'));
const writePerms = PERMISSIONS.filter((p) => p.endsWith(':write'));

/**
 * The two reads pre-tightened on day one (ADR-0046): VIEWER loses `accessGrant:read` and `user:read`;
 * every other `:read` stays granted to all three roles (behavior-preserving). Hand-listed here ON
 * PURPOSE — this is the golden expectation, so it must be stated, not derived from the thing under test.
 */
const VIEWER_DENIED_READS_EXPECTED: Permission[] = [
  'accessGrant:read',
  'user:read',
];

/**
 * The ADMIN-ONLY reads (ADR-0046 extension, issue #175): strictly tighter than the pre-tightening —
 * excluded from BOTH MEMBER and VIEWER, held only by ADMIN's full catalog. Still admin-grantable from
 * the role matrix, but never seeded to MEMBER/VIEWER. Hand-listed here ON PURPOSE — this is the golden
 * expectation, independently stated, not derived from the thing under test.
 */
const ADMIN_ONLY_READS_EXPECTED: Permission[] = ['logs:read'];

/** Build the documented matrix per the ADR-0040 tiers, sorted to the catalog order. */
function documentedMatrix(): RolePermissionMatrix {
  const order = (p: Permission) => PERMISSIONS.indexOf(p);
  const sorted = (perms: Permission[]): Permission[] =>
    [...new Set(perms)].sort((a, b) => order(a) - order(b));

  // ADMIN — the COMPLETE catalog (immutable/full, ADR-0046).
  const admin = sorted([...PERMISSIONS]);

  // MEMBER — all reads + all writes, MINUS the admin-only reads. No `:delete`, no coarse verb (all
  // ADMIN-only per ADR-0040).
  const member = sorted([
    ...readPerms.filter((p) => !ADMIN_ONLY_READS_EXPECTED.includes(p)),
    ...writePerms,
  ]);

  // VIEWER — all reads except the pre-tightened AND the admin-only reads; mutates nothing.
  const viewer = sorted(
    readPerms.filter(
      (p) =>
        !VIEWER_DENIED_READS_EXPECTED.includes(p) &&
        !ADMIN_ONLY_READS_EXPECTED.includes(p),
    ),
  );

  return { ADMIN: admin, MEMBER: member, VIEWER: viewer };
}

// ── Assertions ──────────────────────────────────────────────────────────────────────────────────

const ROLES: Role[] = ['ADMIN', 'MEMBER', 'VIEWER'];

describe('RolePermission golden matrix (ADR-0046)', () => {
  const expected = documentedMatrix();

  it('the seed source (DEFAULT_ROLE_PERMISSIONS) equals the documented matrix EXACTLY, per role', () => {
    for (const role of ROLES) {
      // Order-insensitive set equality, but with an explicit length check so a duplicate or a missing
      // permission both fail loudly.
      const seeded = DEFAULT_ROLE_PERMISSIONS[role];
      const want = expected[role];
      expect(new Set(seeded)).toEqual(new Set(want));
      expect(seeded).toHaveLength(want.length);
    }
  });

  it('the matrix covers exactly the three roles (no extra/missing role key)', () => {
    expect(new Set(Object.keys(DEFAULT_ROLE_PERMISSIONS))).toEqual(new Set(ROLES));
  });

  it('ADMIN holds the complete catalog (immutable/full)', () => {
    expect(new Set(DEFAULT_ROLE_PERMISSIONS.ADMIN)).toEqual(new Set(PERMISSIONS));
  });

  it('VIEWER is read-only and is missing the pre-tightened AND the admin-only reads', () => {
    for (const p of DEFAULT_ROLE_PERMISSIONS.VIEWER) {
      expect(p.endsWith(':read')).toBe(true);
    }
    for (const denied of [
      ...VIEWER_DENIED_READS_EXPECTED,
      ...ADMIN_ONLY_READS_EXPECTED,
    ]) {
      expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain(denied);
    }
    // VIEWER read count == total reads minus the pre-tightened minus the admin-only ones.
    expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).toHaveLength(
      readPerms.length -
        VIEWER_DENIED_READS_EXPECTED.length -
        ADMIN_ONLY_READS_EXPECTED.length,
    );
  });

  it('each :read has the right holders: admin-only → ADMIN; pre-tightened → ADMIN+MEMBER; else all three', () => {
    const tightened = new Set<string>(VIEWER_DENIED_READS_EXPECTED);
    const adminOnly = new Set<string>(ADMIN_ONLY_READS_EXPECTED);
    for (const p of readPerms) {
      const holders = ROLES.filter((r) => DEFAULT_ROLE_PERMISSIONS[r].includes(p));
      if (adminOnly.has(p)) {
        expect(new Set(holders)).toEqual(new Set(['ADMIN']));
      } else if (tightened.has(p)) {
        expect(new Set(holders)).toEqual(new Set(['ADMIN', 'MEMBER']));
      } else {
        expect(new Set(holders)).toEqual(new Set(ROLES));
      }
    }
  });

  it('logs:read is the admin-only read — ADMIN holds it, MEMBER and VIEWER do not', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain('logs:read' as Permission);
    expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).not.toContain('logs:read' as Permission);
    expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain('logs:read' as Permission);
  });

  it('MEMBER never holds a :delete or a coarse capability verb', () => {
    const coarse = ['accessGrant:grant', 'user:manage', 'settings:manage'];
    for (const p of DEFAULT_ROLE_PERMISSIONS.MEMBER) {
      expect(p.endsWith(':delete')).toBe(false);
      expect(coarse).not.toContain(p);
    }
  });
});
