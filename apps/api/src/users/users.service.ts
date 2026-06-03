import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { CreateUser, PageQuery, UpdateUser } from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma, Role } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectUser } from '../search/search.documents';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import type { ActorAttribution } from '../common/actor.service';
import {
  IDENTITY_PROVIDER,
  PasswordResetUnsupportedError,
  type IdentityProvider,
} from '../auth/identity/identity-provider.interface';

/** Optional filters for listing users. */
export interface UserFilters {
  /** Case-insensitive substring over firstName / lastName / email (OR). */
  q?: string;
}

/**
 * Server-side sort allowlist for `GET /users` (ADR-0030 amendment). Maps each PUBLIC `?sort=` key to
 * the Prisma column. Unknown key → 400. With no `sort`, the list keeps its default `createdAt desc`.
 */
export const USER_SORT_ALLOWLIST = {
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email',
  role: 'role',
  createdAt: 'createdAt',
} as const;

/** What an offboarding reclaimed/revoked, for the response + the audit story. */
export interface OffboardResult {
  /** The soft-deleted user (deletedAt stamped). */
  userId: string;
  /** Asset assignments released (reclaimed assets), by id. */
  releasedAssignments: { id: string; assetId: string }[];
  /** Count of active access grants revoked. */
  revokedGrants: number;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly assignments: AssetAssignmentsService,
    // IdP write-back seam (ADR-0043). Zitadel mirrors lazyit's user/role decisions; generic-oidc
    // (BYOI) no-ops every management call. Authorization stays DB-first regardless (decision #1).
    @Inject(IDENTITY_PROVIDER)
    private readonly idp: IdentityProvider,
    @InjectPinoLogger(UsersService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * A single page of users (default `createdAt desc`). Server-side `q` search (over
   * firstName/lastName/email) and an allowlisted sort make the list authoritative — migrated off the
   * raw-array contract that filtered client-side and silently truncated past the window (ADR-0030).
   * The `deleted` slice (`active` default | `only`) scopes the page to live or soft-deleted
   * (offboarded) users; `only` carries the ADR-0032 `includeSoftDeleted` escape hatch so the read
   * filter doesn't re-hide them (ADMIN-gated at the controller). Runs `findMany(take/skip)` + `count`
   * over the same `where` in one `$transaction`.
   */
  async findPage(filters: UserFilters, page: PageQuery) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.UserOrderByWithRelationInput>(
        page,
        USER_SORT_ALLOWLIST,
      ) ??
      ({ createdAt: 'desc' } satisfies Prisma.UserOrderByWithRelationInput);
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object rather than fighting the type.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, orderBy, take, skip, ...escapeHatch }),
      this.prisma.user.count({ where, ...escapeHatch }),
    ]);
    return pageOf(items, total, page);
  }

  /** The shared `where` for the user list — used identically by findPage and its count. */
  private buildWhere({ q }: UserFilters): Prisma.UserWhereInput {
    return q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};
  }

  /** A single non-deleted user by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id },
    });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async create(data: CreateUser, actorId?: string) {
    // RBAC default (ADR-0040, flipped to VIEWER by ADR-0043): an omitted role lands the least-
    // privileged read-only role. We set it explicitly here (rather than leaning on the Prisma column
    // default) so the service is the authoritative default for app-created users and the behaviour is
    // testable without a DB. The Users controller is ADMIN-gated, so an ADMIN may still pass any role.
    const role = data.role ?? Role.VIEWER;
    // DB-first + mirror (ADR-0043 §3): create the LOCAL row first, then mirror into the IdP. If the
    // mirror fails we must NOT leave a split-brain (local user exists, IdP missing) — so we compensate
    // by removing the just-created local row and surface the Management failure as 503. This is the one
    // place a hard delete is correct: the row was created microseconds ago in THIS request, is not yet
    // referenced by anything, and was never visible to a reader — a soft delete would leave a ghost.
    const user = await this.prisma.user.create({
      data: { ...data, role },
    });

    try {
      const ref = await this.idp.createUser({
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role,
      });
      this.auditWriteBack('createUser', actorId, user.id, {
        email: user.email,
        role,
      });
      // Zitadel returns the real user id; persist it as externalId so future grants/deactivate target
      // the managed user. BYOI returns an empty ref (no IdP user) — leave externalId null in that case.
      if (this.idp.supportsManagement && ref.externalId) {
        const linked = await this.prisma.user.update({
          where: { id: user.id },
          data: { externalId: ref.externalId },
        });
        this.search.upsert('users', projectUser(linked));
        return linked;
      }
    } catch (err) {
      // Compensate: roll the local create back so local and Zitadel never disagree (no split-brain).
      await this.compensateLocalCreate(user.id);
      this.logger.error(
        { op: 'createUser', actor: actorId, subjectUserId: user.id },
        `IdP write-back failed on create; rolled back local user (${err instanceof Error ? err.message : String(err)})`,
      );
      throw err;
    }

    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('users', projectUser(user));
    return user;
  }

  /**
   * Roll back a just-created local user when the IdP mirror failed (no-split-brain compensation). A
   * HARD delete is correct here: the row was created in this same request, is unreferenced, and was
   * never returned to a caller, so deleting it leaves no audit/FK orphan (unlike the soft-delete used
   * for genuine offboarding). Best-effort: a delete failure is logged but the original 503 still wins.
   */
  private async compensateLocalCreate(userId: string): Promise<void> {
    try {
      await this.prisma.user.delete({ where: { id: userId } });
    } catch (err) {
      this.logger.error(
        { op: 'compensateLocalCreate', subjectUserId: userId },
        `failed to roll back local user after IdP write-back failure (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /** Structured audit line for a successful IdP write-back (ADR-0043 §3 — no DB audit table yet). */
  private auditWriteBack(
    operation: string,
    actorId: string | undefined,
    subjectUserId: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger.info(
      { op: operation, actor: actorId ?? 'system', subjectUserId, fields },
      `IdP write-back: ${operation}`,
    );
  }

  async update(id: string, data: UpdateUser, actorId?: string) {
    const current = await this.findOne(id); // 404 if missing or already soft-deleted

    // RBAC safety guards (ADR-0040) — only run when a role change is actually requested.
    if (data.role !== undefined && data.role !== current.role) {
      // No self-escalation/demotion: an ADMIN cannot change their OWN role (403). Privilege changes
      // must be made BY one admin ON another, so a single admin can never quietly elevate or strip
      // their own role and there is always a second pair of hands in the loop.
      if (actorId !== undefined && actorId === id) {
        throw new ForbiddenException('You cannot change your own role');
      }
      // Never strip the LAST remaining ADMIN of its role — that would leave the instance with no
      // administrator and no way to recover from the UI (409). Demoting any other admin is fine.
      if (current.role === 'ADMIN' && data.role !== 'ADMIN') {
        await this.assertNotLastAdmin(id);
      }
    }

    const roleChanged = data.role !== undefined && data.role !== current.role;
    // Profile edits an ADMIN can mirror (issue #149). A field only counts as CHANGED when it is present
    // AND differs from the stored value — so a PATCH that resends the same name/email skips the IdP
    // round-trip. `email` is already normalized (trim+lowercase, citext) by the schema (ADR-0041).
    const nameChanged =
      (data.firstName !== undefined && data.firstName !== current.firstName) ||
      (data.lastName !== undefined && data.lastName !== current.lastName);
    const emailChanged =
      data.email !== undefined && data.email !== current.email;
    const profileChanged = nameChanged || emailChanged;

    const user = await this.prisma.user.update({ where: { id }, data });

    // Mirror role and/or profile CHANGES to the IdP (ADR-0043 §3, issue #149). Only when the user is
    // IdP-linked (externalId set) — a local-only row has nothing to mirror. If ANY mirror fails we
    // compensate by reverting the local row back to its pre-update values (role + name + email), so
    // local and Zitadel never disagree (no split-brain, INV-5), and surface the failure as 503. BYOI
    // no-ops grantRole/updateUser → no throw, so this compensation path is Zitadel-only in practice.
    if ((roleChanged || profileChanged) && current.externalId) {
      try {
        if (roleChanged) {
          await this.idp.grantRole(current.externalId, data.role!);
          this.auditWriteBack('grantRole', actorId, id, {
            from: current.role,
            to: data.role,
            externalId: current.externalId,
          });
        }
        if (profileChanged) {
          // externalId (sub) is UNCHANGED — updates the existing Zitadel user, never a re-link
          // (SEC-006). Email is written PRE-VERIFIED by the adapter, so it never forces re-verification.
          await this.idp.updateUser(current.externalId, {
            ...(data.firstName !== undefined &&
            data.firstName !== current.firstName
              ? { firstName: data.firstName }
              : {}),
            ...(data.lastName !== undefined &&
            data.lastName !== current.lastName
              ? { lastName: data.lastName }
              : {}),
            ...(emailChanged ? { email: data.email } : {}),
          });
          this.auditWriteBack('updateUser', actorId, id, {
            // Log WHICH fields changed (the new email is not a secret); never the old values.
            firstName: nameChanged ? data.firstName : undefined,
            lastName: nameChanged ? data.lastName : undefined,
            email: emailChanged ? data.email : undefined,
            externalId: current.externalId,
          });
        }
      } catch (err) {
        // Revert ONLY the fields this update could have changed, back to their pre-update truth, so
        // local and Zitadel agree (the previous values are authoritative) without touching untouched
        // columns. role → role; name → firstName/lastName; email → email.
        const reverted = await this.prisma.user.update({
          where: { id },
          data: {
            ...(roleChanged ? { role: current.role } : {}),
            ...(nameChanged
              ? { firstName: current.firstName, lastName: current.lastName }
              : {}),
            ...(emailChanged ? { email: current.email } : {}),
          },
        });
        this.search.upsert('users', projectUser(reverted));
        this.logger.error(
          { op: 'updateUser', actor: actorId, subjectUserId: id },
          `IdP write-back failed on update; reverted local user to its prior state (${err instanceof Error ? err.message : String(err)})`,
        );
        throw err;
      }
    }

    this.search.upsert('users', projectUser(user));
    return user;
  }

  /**
   * Trigger a password reset for a user (issue #149). lazyit NEVER stores, sets or sends a password
   * (ADR-0016/0037) — it asks the IdP to do it: Zitadel emails a reset link via ZITADEL's own SMTP.
   *
   * Guards (in order): 404 if the user is missing or soft-deleted (findOne filters those out), 422 if
   * the user is INACTIVE (`isActive=false`) — a disabled account is not invited to set a new password
   * until it is reactivated — and an honest 501 (PasswordResetUnsupportedError) for a local-only row
   * with no `externalId`: there is no IdP identity to reset, so we never pretend an email went out.
   *
   * BYOI (generic OIDC) cannot trigger a reset on a foreign IdP: the provider throws
   * PasswordResetUnsupportedError, which the controller maps to a 501 "managed by your identity
   * provider" (INV-4). A Zitadel Management failure surfaces as 503 (consistent with the other writes).
   * Audited via a structured log line (no DB audit table yet — ADR-0043 §3).
   */
  async requestPasswordReset(id: string, actorId?: string): Promise<void> {
    const user = await this.findOne(id); // 404 if missing or already soft-deleted

    if (!user.isActive) {
      throw new UnprocessableEntityException(
        'Cannot reset the password of an inactive user. Reactivate the account first.',
      );
    }
    if (!user.externalId) {
      // No IdP identity to reset — honest 501 (same shape BYOI returns), never a misleading 2xx.
      throw new PasswordResetUnsupportedError(
        'This user is not linked to an identity provider, so a password reset cannot be triggered.',
      );
    }

    await this.idp.requestPasswordReset(user.externalId);
    this.auditWriteBack('requestPasswordReset', actorId, id, {
      externalId: user.externalId,
    });
  }

  /**
   * Throws 409 Conflict if `userId` is the only remaining live ADMIN. Used before any action that
   * would remove their administrator powers (role demotion, offboarding, delete), so a fresh install
   * — or any instance — is never left without an administrator. Counts LIVE admins only (the read
   * filter already excludes soft-deleted users), so an offboarded admin doesn't count toward the
   * total. The check-then-act window is acceptable for a 5–20-person single-org tool: the worst case
   * is two near-simultaneous demotions both passing, which is the same class of race ADR-0040 already
   * accepts for first-user-ADMIN, and strictly safer than locking everyone out.
   */
  private async assertNotLastAdmin(userId: string) {
    const otherAdmins = await this.prisma.user.count({
      where: { role: 'ADMIN', id: { not: userId } },
    });
    if (otherAdmins === 0) {
      throw new ConflictException(
        'Cannot remove the last administrator. Promote another user to ADMIN first.',
      );
    }
  }

  /**
   * Soft-delete (offboard) a user. Never hard-delete (auditability is a first principle), but a
   * soft delete alone left the user's access live — the audit gap this closes. In ONE transaction
   * we (1) revoke every active AccessGrant the user holds, (2) release every active AssetAssignment
   * (reclaiming the assets) and append a RELEASED asset-history event for each, then (3) stamp
   * `deletedAt`. All-or-nothing: a failure rolls the whole offboarding back, so a user is never left
   * half-offboarded (deleted but still holding grants/assets, or vice-versa).
   *
   * `actor` is the authenticated principal performing the offboarding (from @CurrentPrincipal via the
   * controller). A human is stamped as `revokedById` / `releasedById`; a service account holding
   * `user:manage` is stamped as `revokedBySaId` / `releasedBySaId` so the action stays attributable and
   * the at-most-one-actor CHECK is honored (ADR-0048). Grant revocation is done INLINE here
   * (prisma.accessGrant.updateMany) rather than via the access-grants service, to keep it inside this
   * single transaction. The IdP write-back JSON audit line still uses the human actor id (a structured
   * log, not a DB FK column).
   */
  async remove(
    id: string,
    actor: ActorAttribution = {},
  ): Promise<OffboardResult> {
    const target = await this.findOne(id); // 404 if missing or already soft-deleted

    // Last-admin safety guard (ADR-0040): offboarding/deleting the only remaining ADMIN would leave
    // the instance with no administrator (409). Offboarding a non-last admin, or any non-admin, is
    // fine. Mirrors the role-demotion guard in update().
    if (target.role === 'ADMIN') {
      await this.assertNotLastAdmin(id);
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // 0. Deactivate the user in the IdP FIRST, inside the transaction (ADR-0043 §2c). A Management
      // failure throws here and rolls the ENTIRE offboarding back — so we never end up with a
      // soft-deleted-local / still-active-in-Zitadel split-brain (the failure surfaces as 503). For an
      // IdP-linked user only; a local-only row (externalId null) has nothing to deactivate. BYOI
      // no-ops deactivateUser → no throw, offboarding proceeds locally exactly as before.
      if (target.externalId) {
        await this.idp.deactivateUser(target.externalId);
        this.auditWriteBack('deactivateUser', actor.userId, id, {
          externalId: target.externalId,
        });
      }

      // 1. Revoke all the user's active (not-yet-revoked) access grants. Attribute the offboarding
      // actor on each: human → revokedById, service account → revokedBySaId (CHECK-safe; ADR-0048).
      const { count: revokedGrants } = await tx.accessGrant.updateMany({
        where: { userId: id, revokedAt: null },
        data: {
          revokedAt: now,
          ...(actor.userId != null ? { revokedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { revokedBySaId: actor.serviceAccountId }
            : {}),
          notes: 'auto: offboarded',
        },
      });

      // 2. Release all the user's active asset assignments (+ RELEASED history per asset). The actor is
      // threaded so the releases attribute to the right column (releasedById / releasedBySaId).
      const releasedAssignments = await this.assignments.releaseAllForUser(
        tx,
        id,
        actor,
      );

      // 3. Soft-delete the user.
      await tx.user.update({ where: { id }, data: { deletedAt: now } });

      return { userId: id, releasedAssignments, revokedGrants };
    });

    // Drop from the index so soft-deleted users never surface in search (ADR-0035). Outside the tx:
    // fire-and-forget, must never roll back the DB offboarding.
    this.search.remove('users', id);
    return result;
  }

  /**
   * Restore (re-onboard) a soft-deleted user: clear `deletedAt` (ADR-0041). Deliberately does NOT
   * re-grant the access or re-assign the assets that offboarding revoked/released — those are
   * separate, intentional acts; restore only makes the account exist (and log in) again. Found via
   * the `includeSoftDeleted` escape hatch (the read filter would hide it). 404 if it never existed;
   * idempotent if already live. The partial unique index frees `email` on delete, so a restore can
   * 409 if the (case-insensitive) email was reused by another live user in the meantime (mapped by
   * the global PrismaExceptionFilter). Re-indexes for search on success.
   */
  async restore(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.UserFindFirstArgs);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    if (user.deletedAt === null) {
      return user; // already live — idempotent
    }
    const restored = await this.prisma.user.update({
      where: { id },
      data: { deletedAt: null },
    });
    // Re-index the restored user (ADR-0035).
    this.search.upsert('users', projectUser(restored));
    return restored;
  }
}
