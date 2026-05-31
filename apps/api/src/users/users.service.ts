import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateUser, UpdateUser } from '@lazyit/shared';
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

  async update(id: string, data: UpdateUser) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const user = await this.prisma.user.update({ where: { id }, data });
    this.search.upsert('users', projectUser(user));
    return user;
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
    await this.findOne(id); // 404 if missing or already soft-deleted

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
}
