import { BadRequestException, Injectable } from '@nestjs/common';
import {
  missingImpliedReads,
  PERMISSIONS,
  type MyPermissions,
  type Permission,
  type RolePermissionMatrix,
  type UpdateRolePermissions,
} from '@lazyit/shared';
import { Role } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { NotificationsService } from '../notifications/notifications.service';

/** The roles the config surface may edit. ADMIN is immutable/full (ADR-0046) and never appears here. */
const EDITABLE_ROLES = [Role.MEMBER, Role.VIEWER] as const;

/**
 * The coarse, high-risk verbs whose GRANT to a non-admin role is a SENSITIVE audit event worth a
 * broadcast nudge (ADR-0056 amendment / issue #852). The explicit set plus every `:delete` verb, per
 * the issue: raising MEMBER/VIEWER to instance config, user administration, access-grant control, or any
 * destructive verb is exactly the "an admin should glance at this" widening. NOT a firehose — a normal
 * `asset:write` grant is silent.
 */
const HIGH_RISK_VERBS = new Set<string>([
  'settings:manage',
  'user:manage',
  'accessGrant:grant',
]);
const isHighRiskVerb = (permission: string): boolean =>
  HIGH_RISK_VERBS.has(permission) || permission.endsWith(':delete');

/** One write-without-read in a PUT body that the stored matrix did not already carry (#1518). */
interface ReadRequiredViolation {
  role: Role;
  permission: Permission;
  requires: Permission;
}

/**
 * The configurable role→permission matrix backend (Roles & Permissions v2, ADR-0046 P5).
 *
 * Owns the editable surface around the frozen catalog:
 *   - {@link getMatrix}       — materialize the current `RolePermission` rows as the wire matrix.
 *   - {@link updateMatrix}    — replace the MEMBER + VIEWER sets transactionally, audit every added /
 *                               removed permission, and invalidate the resolver cache so the next
 *                               authZ decision reflects the change (cache coherence).
 *   - {@link resolveFor}      — the caller's effective permission set, via the resolver (ADMIN → full).
 *
 * GUARDRAILS (ADR-0046 P5): the ADMIN row is IMMUTABLE (the strict PUT body can't even name it) and
 * every permission must be in the frozen `@lazyit/shared` catalog (the body's zod enum rejects an
 * unknown literal with a 400 before this runs). Within those two limits, MEMBER/VIEWER are fully
 * configurable — granting MEMBER a `:delete` or a coarse verb is the intended feature, not a leak.
 *
 * WRITE IMPLIES READ (#1518, CEO decision): a role holding a non-read verb on a domain must hold that
 * domain's read (`missingImpliedReads`, derived from the catalog in `@lazyit/shared`). {@link updateMatrix}
 * refuses a body that INTRODUCES a write-without-read with 400 `PERMISSION_READ_REQUIRED`, and HEALS one
 * the stored matrix already carried (a legacy row from before the rule) by adding the read — never by
 * dropping the write, so nobody loses a capability they had. Reads stay tolerant: {@link getMatrix}
 * returns the stored rows as they are.
 *
 * ADMIN is NEVER materialized from the DB here: the resolver always returns the complete catalog for
 * ADMIN regardless of any rows, so {@link getMatrix} reports the catalog for ADMIN to match what the
 * resolver actually enforces (a stray/absent ADMIN row can never lock ADMIN out — INV-8).
 */
@Injectable()
export class PermissionsConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolverService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The current per-role permission matrix (`GET /config/permissions`). MEMBER/VIEWER are read from
   * their `RolePermission` rows (catalog-filtered, sorted by catalog order for a stable shape); ADMIN
   * is the COMPLETE catalog — what the resolver actually enforces — never the DB rows.
   */
  async getMatrix(): Promise<RolePermissionMatrix> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { role: { in: [...EDITABLE_ROLES] } },
      select: { role: true, permission: true },
    });

    const byRole: Record<Role, Permission[]> = {
      [Role.ADMIN]: this.sorted(PERMISSIONS),
      [Role.MEMBER]: [],
      [Role.VIEWER]: [],
    };
    for (const { role, permission } of rows) {
      // Keep only catalog literals — a stray DB row can never surface a permission the code doesn't know.
      if (this.isCatalogPermission(permission)) {
        byRole[role].push(permission);
      }
    }
    byRole[Role.MEMBER] = this.sorted(byRole[Role.MEMBER]);
    byRole[Role.VIEWER] = this.sorted(byRole[Role.VIEWER]);
    return byRole;
  }

  /**
   * Replace the MEMBER and VIEWER permission sets (`PUT /config/permissions`). The body is already
   * catalog-validated and ADMIN-free (strict zod in `@lazyit/shared`). The whole change is applied in
   * ONE transaction — per editable role: diff the desired set against the current rows, delete the
   * revoked, create the granted, and append one immutable `PermissionAuditLog` row per change
   * (grant/revoke) attributed to the actor. On commit, the resolver cache is invalidated so the very
   * next authorization decision re-reads the DB (cache coherence). Returns the resulting matrix.
   *
   * @param body    desired MEMBER + VIEWER permission sets (deduped, catalog-valid).
   * @param actorId the authenticated ADMIN's User.id (null only in the anonymous shim edge — audited as null).
   */
  async updateMatrix(
    body: UpdateRolePermissions,
    actorId: string | null,
  ): Promise<RolePermissionMatrix> {
    const desired: Record<(typeof EDITABLE_ROLES)[number], Permission[]> = {
      [Role.MEMBER]: body.MEMBER,
      [Role.VIEWER]: body.VIEWER,
    };

    // Collected inside the tx, emitted AFTER commit (ADR-0056 §3 best-effort): the high-risk verbs newly
    // GRANTED to each non-admin role this edit. Empty ⇒ no sensitive widening ⇒ no nudge.
    const widened: { role: Role; permission: string }[] = [];

    await this.prisma.$transaction(async (tx) => {
      // Read both roles' stored sets first, so the write-implies-read check (#1518) runs over the whole
      // body before anything is written.
      const current: Record<(typeof EDITABLE_ROLES)[number], Set<string>> = {
        [Role.MEMBER]: new Set(),
        [Role.VIEWER]: new Set(),
      };
      for (const role of EDITABLE_ROLES) {
        const currentRows = await tx.rolePermission.findMany({
          where: { role },
          select: { permission: true },
        });
        current[role] = new Set(currentRows.map((r) => r.permission));
      }
      const healed = this.enforceImpliedReads(desired, current);

      for (const role of EDITABLE_ROLES) {
        const next = new Set<string>(healed[role]);

        const toRevoke = [...current[role]].filter((p) => !next.has(p));
        const toGrant = [...next].filter((p) => !current[role].has(p));

        for (const permission of toGrant) {
          if (isHighRiskVerb(permission)) {
            widened.push({ role, permission });
          }
        }

        if (toRevoke.length > 0) {
          await tx.rolePermission.deleteMany({
            where: { role, permission: { in: toRevoke } },
          });
        }
        if (toGrant.length > 0) {
          await tx.rolePermission.createMany({
            data: toGrant.map((permission) => ({ role, permission })),
          });
        }

        // Append-only audit: one immutable row per added / removed permission (ADR-0006 / ADR-0046 P5).
        const auditRows = [
          ...toGrant.map((permission) => ({
            actorId,
            role,
            permission,
            action: 'GRANT' as const,
          })),
          ...toRevoke.map((permission) => ({
            actorId,
            role,
            permission,
            action: 'REVOKE' as const,
          })),
        ];
        if (auditRows.length > 0) {
          await tx.permissionAuditLog.createMany({ data: auditRows });
        }
      }
    });

    // Cache coherence (ADR-0046 P5): drop every cached role set so the next authZ decision re-reads
    // the DB. ADMIN isn't cached (always full), but a blanket invalidate is cheapest and safest.
    this.resolver.invalidate();

    // Sensitive-audit alert (ADR-0056 amendment / #852): if this edit raised MEMBER/VIEWER to any
    // high-risk verb, broadcast ONE nudge to the admin feed, POST-COMMIT + best-effort (emit never
    // throws — a failed nudge must never roll back the matrix edit). ponytail: no "self-escalation"
    // axis to distinguish here — only an ADMIN can edit the matrix (AdminOnlyGuard, SEC-088), ADMIN is
    // immutable/full (INV-8), and edits target the MEMBER/VIEWER ROLE sets, never the actor's own
    // account, so an admin can never widen *themselves*. Ceiling: revisit only if per-user grants land.
    if (widened.length > 0) {
      await this.emitWidened(widened, actorId);
    }

    return this.getMatrix();
  }

  /**
   * Write implies read (#1518). For each editable role, every permission of the body whose implied read
   * the body leaves out is either:
   *   - LEGACY — the stored set already held that permission without its read (a matrix saved before the
   *     rule): healed by adding the read to the desired set. The write is never removed, so nobody loses
   *     a capability; the role gains the matching view, audited as a GRANT like any other.
   *   - NEW — the body grants the permission, or revokes the read it needs: refused with 400
   *     `PERMISSION_READ_REQUIRED`, listing every such pair, and nothing is written. The editor never
   *     sends one (it turns the read on with the write); this is the server's half of the rule.
   * Returns the desired sets with the legacy reads added.
   */
  private enforceImpliedReads(
    desired: Record<(typeof EDITABLE_ROLES)[number], Permission[]>,
    current: Record<(typeof EDITABLE_ROLES)[number], ReadonlySet<string>>,
  ): Record<(typeof EDITABLE_ROLES)[number], Permission[]> {
    const healed = { ...desired };
    const violations: ReadRequiredViolation[] = [];
    for (const role of EDITABLE_ROLES) {
      const additions: Permission[] = [];
      for (const { permission, requires } of missingImpliedReads(
        desired[role],
      )) {
        const legacy =
          current[role].has(permission) && !current[role].has(requires);
        if (legacy) additions.push(requires);
        else violations.push({ role, permission, requires });
      }
      healed[role] = [...new Set([...desired[role], ...additions])];
    }
    if (violations.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PERMISSION_READ_REQUIRED',
        message:
          'A role that can change something must also be able to view it: grant the read permission, or remove the permissions that need it.',
        violations,
      });
    }
    return healed;
  }

  /**
   * Broadcast the `permission_widened` nudge for a set of newly-granted high-risk verbs (ADR-0056
   * amendment / #852). One notification per matrix edit (not per verb) — deduped on the emit instant so
   * two distinct edits never collapse. Metadata is REDACTED (role + verb literals only, no bodies).
   */
  private async emitWidened(
    widened: { role: Role; permission: string }[],
    actorId: string | null,
  ): Promise<void> {
    const roles = [...new Set(widened.map((w) => w.role))].sort();
    const verbs = [...new Set(widened.map((w) => w.permission))].sort();
    await this.notifications.emit({
      type: 'permission_widened',
      // The matrix PUT is not retried by infra, and a re-run diffs to an empty grant set (nothing new to
      // grant) — so a timestamp keeps distinct edits distinct without ever suppressing a real one.
      dedupeKey: `permission_widened:${actorId ?? 'system'}:${Date.now()}`,
      severity: 'warning',
      title: `Sensitive permissions granted to ${roles.join(' & ')}`,
      summary: `${roles.join(' & ')} now holds high-risk access: ${verbs.join(', ')}.`,
      // No entityType — the bell deep-links this type to the role→permission matrix.
      metadata: { roles, permissions: verbs, actorId },
    });
  }

  /**
   * The CALLER's effective permission set (`GET /config/my-permissions`), resolved via the
   * `PermissionResolverService` so it matches EXACTLY what the guard enforces (ADMIN → the complete
   * catalog; MEMBER/VIEWER → their DB rows). The frontend derives `can('domain:action')` from this.
   */
  async resolveFor(role: Role): Promise<MyPermissions> {
    const held = await this.resolver.resolve(role);
    return { role, permissions: this.sorted([...held]) };
  }

  /** True when the string is a literal in the frozen `@lazyit/shared` catalog. */
  private isCatalogPermission(permission: string): permission is Permission {
    return (PERMISSIONS as readonly string[]).includes(permission);
  }

  /** Permissions sorted by their catalog order — a stable, reviewable shape (mirrors the seed). */
  private sorted(perms: readonly Permission[]): Permission[] {
    const order = (p: Permission) => PERMISSIONS.indexOf(p);
    return [...new Set(perms)].sort((a, b) => order(a) - order(b));
  }
}
