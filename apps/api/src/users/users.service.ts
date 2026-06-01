import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateUser, UpdateUser } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectUser } from '../search/search.documents';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';

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
  ) {}

  /** All users that have not been soft-deleted. */
  findAll() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
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

  async create(data: CreateUser) {
    const user = await this.prisma.user.create({ data });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('users', projectUser(user));
    return user;
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

    const user = await this.prisma.user.update({ where: { id }, data });
    this.search.upsert('users', projectUser(user));
    return user;
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
   * `actorId` is the authenticated user performing the offboarding (from @CurrentUser via the
   * controller). It is stamped as `revokedById` / `releasedById` so the action is attributable.
   * Grant revocation is done INLINE here (prisma.accessGrant.updateMany) rather than via the
   * access-grants service, to keep it inside this single transaction.
   */
  async remove(id: string, actorId?: string): Promise<OffboardResult> {
    const target = await this.findOne(id); // 404 if missing or already soft-deleted

    // Last-admin safety guard (ADR-0040): offboarding/deleting the only remaining ADMIN would leave
    // the instance with no administrator (409). Offboarding a non-last admin, or any non-admin, is
    // fine. Mirrors the role-demotion guard in update().
    if (target.role === 'ADMIN') {
      await this.assertNotLastAdmin(id);
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Revoke all the user's active (not-yet-revoked) access grants.
      const { count: revokedGrants } = await tx.accessGrant.updateMany({
        where: { userId: id, revokedAt: null },
        data: {
          revokedAt: now,
          ...(actorId !== undefined ? { revokedById: actorId } : {}),
          notes: 'auto: offboarded',
        },
      });

      // 2. Release all the user's active asset assignments (+ RELEASED history per asset).
      const releasedAssignments = await this.assignments.releaseAllForUser(
        tx,
        id,
        actorId,
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
