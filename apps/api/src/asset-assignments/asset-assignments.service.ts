import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateAssetAssignment,
  ReleaseAssetAssignment,
  UpdateAssetAssignmentNotes,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Filters for listing assignments. `activeOnly` defaults to true (set at the controller). */
export interface FindAssignmentsFilters {
  assetId?: string;
  userId?: string;
  activeOnly?: boolean;
}

@Injectable()
export class AssetAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Assignments, newest first; filter by asset/user and (by default) active only. */
  findAll({ assetId, userId, activeOnly = true }: FindAssignmentsFilters) {
    return this.prisma.assetAssignment.findMany({
      where: {
        ...(assetId ? { assetId } : {}),
        ...(userId ? { userId } : {}),
        ...(activeOnly ? { releasedAt: null } : {}),
      },
      orderBy: { assignedAt: 'desc' },
    });
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
   */
  async create(data: CreateAssetAssignment) {
    const existingActive = await this.prisma.assetAssignment.findFirst({
      where: { assetId: data.assetId, userId: data.userId, releasedAt: null },
    });
    if (existingActive) {
      throw new ConflictException(
        'An active assignment already exists for this asset and user',
      );
    }
    return this.prisma.assetAssignment.create({ data });
  }

  /**
   * Release an active assignment: set `releasedAt = now()` (+ optional releasedById / notes).
   * 404 if missing; 409 if already released (release is not repeatable). Releasing one owner
   * does not affect any other active assignment on the same asset.
   */
  async release(id: string, data: ReleaseAssetAssignment) {
    const assignment = await this.findOne(id);
    if (assignment.releasedAt !== null) {
      throw new ConflictException(`AssetAssignment ${id} is already released`);
    }
    return this.prisma.assetAssignment.update({
      where: { id },
      data: {
        releasedAt: new Date(),
        ...(data.releasedById !== undefined
          ? { releasedById: data.releasedById }
          : {}),
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
}
