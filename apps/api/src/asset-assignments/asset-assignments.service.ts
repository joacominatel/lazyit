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

/** Filters for listing assignments. `activeOnly` defaults to true (set at the controller). */
export interface FindAssignmentsFilters {
  assetId?: string;
  userId?: string;
  activeOnly?: boolean;
  /** When true, inline each assignment's owner (`user`). Used by GET /assets/:id/assignments. */
  includeUser?: boolean;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The actor (`assignedById` on create, `releasedById` on release) comes from the optional
 * `X-User-Id` shim — never the request body (ADR-0024, converging on the AccessGrant pattern of
 * ADR-0022/0023). When real auth lands, the actor comes from the JWT and these methods are
 * unchanged.
 */
@Injectable()
export class AssetAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

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
   * Open an assignment (assign a user to an asset). Rejects a duplicate *active* (asset, user)
   * pair with 409 — a friendly pre-check; the partial unique index is the race-proof backstop
   * (also surfaces as 409 via PrismaExceptionFilter). An invalid assetId/userId hits the FK and
   * is mapped to 400 (P2003). A different user on the same asset is allowed (multi-owner).
   * `assignedById` is set from the `X-User-Id` shim when present (null = system/unknown).
   */
  async create(data: CreateAssetAssignment, actorId?: string) {
    const assignedById = await this.resolveActor(actorId);
    const existingActive = await this.prisma.assetAssignment.findFirst({
      where: { assetId: data.assetId, userId: data.userId, releasedAt: null },
    });
    if (existingActive) {
      throw new ConflictException(
        'An active assignment already exists for this asset and user',
      );
    }
    return this.prisma.assetAssignment.create({
      data: {
        ...data,
        ...(assignedById !== undefined ? { assignedById } : {}),
      },
    });
  }

  /**
   * Release an active assignment: set `releasedAt = now()` (+ `releasedById` from the shim,
   * optional `notes`). 404 if missing; 409 if already released (release is not repeatable).
   * Releasing one owner does not affect any other active assignment on the same asset.
   */
  async release(id: string, data: ReleaseAssetAssignment, actorId?: string) {
    const assignment = await this.findOne(id);
    if (assignment.releasedAt !== null) {
      throw new ConflictException(`AssetAssignment ${id} is already released`);
    }
    const releasedById = await this.resolveActor(actorId);
    return this.prisma.assetAssignment.update({
      where: { id },
      data: {
        releasedAt: new Date(),
        ...(releasedById !== undefined ? { releasedById } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });
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
   * Resolve the optional `X-User-Id` actor: undefined/empty → undefined (system/unknown, leaves the
   * FK null). A present value must be a valid live user, else 400 (don't silently drop a bad id; a
   * soft-deleted user can't act as an actor). Mirrors AccessGrantsService.resolveActor — a shared
   * helper is a future refactor candidate once a third caller appears.
   */
  private async resolveActor(actorId?: string): Promise<string | undefined> {
    if (actorId === undefined || actorId === '') return undefined;
    if (!UUID_REGEX.test(actorId)) {
      throw new BadRequestException('X-User-Id is not a valid user id');
    }
    const user = await this.prisma.user.findFirst({
      where: { id: actorId },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException(
        'X-User-Id does not reference a valid user',
      );
    }
    return user.id;
  }
}
