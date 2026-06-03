import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateAssetAssignment,
  ReleaseAssetAssignment,
  UpdateAssetAssignmentNotes,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService, type ActorAttribution } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { AssetHistoryService } from '../asset-history/asset-history.service';

/** Filters for listing assignments. `activeOnly` defaults to true (set at the controller). */
export interface FindAssignmentsFilters {
  assetId?: string;
  userId?: string;
  activeOnly?: boolean;
  /** When true, inline each assignment's owner (`user`). Used by GET /assets/:id/assignments. */
  includeUser?: boolean;
}

/**
 * The actor comes from the unified PRINCIPAL resolved by JwtAuthGuard (@CurrentPrincipal()) — never the
 * request body (ADR-0024/0038/0048). A human is attributed to `assignedById` / `releasedById`; a service
 * account to `assignedBySaId` / `releasedBySaId` (a DB CHECK enforces at-most-one actor per slot).
 * Opening and releasing also emit `ASSIGNED` / `RELEASED` asset-history events transactionally (ADR-0033).
 */
@Injectable()
export class AssetAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
  ) {}

  /** Assignments, newest first; filter by asset/user and (by default) active only. */
  findAll({
    assetId,
    userId,
    activeOnly = true,
    includeUser = false,
  }: FindAssignmentsFilters) {
    const args: Prisma.AssetAssignmentFindManyArgs = {
      where: {
        ...(assetId ? { assetId } : {}),
        ...(userId ? { userId } : {}),
        ...(activeOnly ? { releasedAt: null } : {}),
      },
      orderBy: { assignedAt: 'desc' },
      // Inline the owner only when asked (other callers keep the lean shape).
      ...(includeUser ? { include: { user: true } } : {}),
    };
    return this.prisma.assetAssignment.findMany(args);
  }

  /** A single assignment by id; throws 404 if missing. (No soft delete — none to filter.) */
  async findOne(id: string) {
    const assignment = await this.prisma.assetAssignment.findUnique({
      where: { id },
    });
    if (!assignment) {
      throw new NotFoundException(`AssetAssignment ${id} not found`);
    }
    return assignment;
  }

  /**
   * Open an assignment (assign a user to an asset). `assetId` and `userId` must reference **live**
   * (non-soft-deleted) rows → 400 otherwise (don't assign a decommissioned asset or a departed user;
   * mirrors AccessGrantsService.create). Rejects a duplicate *active* (asset, user) pair with 409 —
   * a friendly pre-check; the partial unique index is the race-proof backstop (also surfaces as 409
   * via PrismaExceptionFilter). A different user on the same asset is allowed (multi-owner).
   * `assignedById` is set from the authenticated User when present (null = system/unknown).
   */
  async create(data: CreateAssetAssignment, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    await this.assertAssetUsable(data.assetId);
    await this.assertUserUsable(data.userId);
    const existingActive = await this.prisma.assetAssignment.findFirst({
      where: { assetId: data.assetId, userId: data.userId, releasedAt: null },
    });
    if (existingActive) {
      throw new ConflictException(
        'An active assignment already exists for this asset and user',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.assetAssignment.create({
        data: {
          ...data,
          // Attribute the OPEN action: human → assignedById, service account → assignedBySaId. The DB
          // at-most-one-actor CHECK on (assignedById, assignedBySaId) is satisfied because resolveActor
          // returns at most one of the pair (ADR-0048).
          ...(actor.userId != null ? { assignedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { assignedBySaId: actor.serviceAccountId }
            : {}),
        },
      });
      await this.history.record(tx, {
        assetId: data.assetId,
        eventType: 'ASSIGNED',
        payload: { userId: data.userId },
        actor,
      });
      return assignment;
    });
  }

  /**
   * Release an active assignment: set `releasedAt = now()` (+ `releasedById` from the authenticated
   * User, optional `notes`). 404 if missing; 409 if already released (release is not repeatable).
   * Releasing one owner does not affect any other active assignment on the same asset.
   */
  async release(
    id: string,
    data: ReleaseAssetAssignment,
    principal?: Principal,
  ) {
    const assignment = await this.findOne(id);
    if (assignment.releasedAt !== null) {
      throw new ConflictException(`AssetAssignment ${id} is already released`);
    }
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      const released = await tx.assetAssignment.update({
        where: { id },
        data: {
          releasedAt: new Date(),
          // Attribute the RELEASE action: human → releasedById, service account → releasedBySaId.
          // CHECK-safe by construction (resolveActor returns at most one of the pair; ADR-0048).
          ...(actor.userId != null ? { releasedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { releasedBySaId: actor.serviceAccountId }
            : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      });
      await this.history.record(tx, {
        assetId: assignment.assetId,
        eventType: 'RELEASED',
        // Mirror ASSIGNED's {userId}: a multi-owner asset can release one of several owners, so the
        // released owner must be on the RELEASED row to disambiguate the timeline.
        payload: { userId: assignment.userId },
        actor,
      });
      return released;
    });
  }

  /**
   * Release EVERY active assignment owned by `userId`, atomically with the caller's transaction
   * (used by user offboarding — users.service.remove). Mirrors {@link release}: stamps
   * `releasedAt = now()` + `releasedById = actorId` on each open assignment and emits one `RELEASED`
   * asset-history event per asset (ADR-0033) so the audit trail stays complete.
   *
   * Takes the caller's `$transaction` client so the releases, the history rows and the user
   * soft-delete all commit together (or all roll back). No-op (returns []) when the user owns no
   * active assignment. The history client is structurally typed; the tx client satisfies it.
   *
   * @returns the released assignment ids (reclaimed assets), for the offboarding summary.
   */
  async releaseAllForUser(
    tx: Prisma.TransactionClient,
    userId: string,
    actor: ActorAttribution = {},
  ): Promise<{ id: string; assetId: string }[]> {
    const active = await tx.assetAssignment.findMany({
      where: { userId, releasedAt: null },
      select: { id: true, assetId: true },
    });
    const now = new Date();
    for (const assignment of active) {
      await tx.assetAssignment.update({
        where: { id: assignment.id },
        data: {
          releasedAt: now,
          // Attribute the offboarding actor on each release: human → releasedById, SA → releasedBySaId
          // (an SA holding user:manage may run the offboarding). CHECK-safe (ADR-0048).
          ...(actor.userId != null ? { releasedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { releasedBySaId: actor.serviceAccountId }
            : {}),
        },
      });
      await this.history.record(tx, {
        assetId: assignment.assetId,
        eventType: 'RELEASED',
        // Stamp the released owner (same as release()): the RELEASED rows are attributable per owner.
        payload: { userId },
        actor,
      });
    }
    return active;
  }

  /**
   * Update only the notes (the one mutable field besides releasedAt; identity is immutable).
   * Allowed even after release; `null` clears the note. 404 if missing.
   */
  async updateNotes(id: string, data: UpdateAssetAssignmentNotes) {
    await this.findOne(id);
    return this.prisma.assetAssignment.update({
      where: { id },
      data: { notes: data.notes },
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * 400 if assetId doesn't reference a live (non-soft-deleted) asset. The soft-delete read filter
   * hides deleted assets, so findFirst returns null for them — assigning a decommissioned asset is
   * a client error, not a 500 at the FK. Mirrors AccessGrantsService.assertApplicationUsable.
   */
  private async assertAssetUsable(assetId: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId },
      select: { id: true },
    });
    if (!asset) {
      throw new BadRequestException(
        `assetId ${assetId} does not reference a live asset`,
      );
    }
  }

  /**
   * 400 if userId doesn't reference a live (non-soft-deleted) user — don't assign an asset to a
   * departed/offboarded user. Mirrors AccessGrantsService.assertUserUsable.
   */
  private async assertUserUsable(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException(
        `userId ${userId} does not reference a live user`,
      );
    }
  }
}
