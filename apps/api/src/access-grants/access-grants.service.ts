import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateAccessGrant,
  RevokeAccessGrant,
  UpdateAccessGrantExpiry,
  UpdateAccessGrantNotes,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Filters for listing grants. `activeOnly` / `includeExpired` default to true (set at the controller). */
export interface FindAccessGrantsFilters {
  userId?: string;
  applicationId?: string;
  activeOnly?: boolean;
  includeExpired?: boolean;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * AccessGrant — the User↔Application access join (append-only, revoked via `revokedAt`; ADR-0023).
 * The actor (`grantedById` on create, `revokedById` on revoke) comes from the optional `X-User-Id`
 * shim — never the request body (ADR-0022). When real auth lands, the actor comes from the JWT and
 * these methods are unchanged.
 */
@Injectable()
export class AccessGrantsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Grants, newest first. Filters: user, application, `activeOnly` (only `revokedAt = null`,
   * default true) and `includeExpired` (default true; when false, hides grants already past their
   * `expiresAt`). `expiresAt` never changes activeness — it's informative (ADR-0023).
   */
  findAll({
    userId,
    applicationId,
    activeOnly = true,
    includeExpired = true,
  }: FindAccessGrantsFilters) {
    const where: Prisma.AccessGrantWhereInput = {
      ...(userId ? { userId } : {}),
      ...(applicationId ? { applicationId } : {}),
      ...(activeOnly ? { revokedAt: null } : {}),
      ...(includeExpired
        ? {}
        : { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }),
    };
    return this.prisma.accessGrant.findMany({
      where,
      orderBy: { grantedAt: 'desc' },
    });
  }

  /** A single grant by id; throws 404 if missing. (No soft delete — none to filter.) */
  async findOne(id: string) {
    const grant = await this.prisma.accessGrant.findUnique({ where: { id } });
    if (!grant) {
      throw new NotFoundException(`AccessGrant ${id} not found`);
    }
    return grant;
  }

  /**
   * Open a grant (give a user access to an application). `userId` and `applicationId` must reference
   * **live** (non-soft-deleted) rows → 400 otherwise (don't grant access to a decommissioned app or
   * a departed user). Multi-grant is allowed: no uniqueness check. `grantedById` is set from the
   * `X-User-Id` shim when present (null = system/unknown).
   */
  async create(data: CreateAccessGrant, actorId?: string) {
    const grantedById = await this.resolveActor(actorId);
    await this.assertUserUsable(data.userId);
    await this.assertApplicationUsable(data.applicationId);
    return this.prisma.accessGrant.create({
      data: {
        userId: data.userId,
        applicationId: data.applicationId,
        ...(data.accessLevel !== undefined
          ? { accessLevel: data.accessLevel }
          : {}),
        ...(data.expiresAt !== undefined
          ? { expiresAt: new Date(data.expiresAt) }
          : {}),
        ...(data.grantedAt !== undefined
          ? { grantedAt: new Date(data.grantedAt) }
          : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(grantedById !== undefined ? { grantedById } : {}),
      },
    });
  }

  /**
   * Revoke an active grant: set `revokedAt = now()` (+ `revokedById` from the shim, optional `notes`).
   * 404 if missing; 409 if already revoked (revoke is not repeatable). Revoking one grant does not
   * affect any other grant the same user holds on the same application.
   */
  async revoke(id: string, data: RevokeAccessGrant, actorId?: string) {
    const grant = await this.findOne(id);
    if (grant.revokedAt !== null) {
      throw new ConflictException(`AccessGrant ${id} is already revoked`);
    }
    const revokedById = await this.resolveActor(actorId);
    return this.prisma.accessGrant.update({
      where: { id },
      data: {
        revokedAt: new Date(),
        ...(revokedById !== undefined ? { revokedById } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });
  }

  /**
   * Update only the notes (a metadata edit, no actor). Allowed even after revoke; `null` clears the
   * note. Identity (user, application, grantedAt) is immutable. 404 if missing.
   */
  async updateNotes(id: string, data: UpdateAccessGrantNotes) {
    await this.findOne(id);
    return this.prisma.accessGrant.update({
      where: { id },
      data: { notes: data.notes },
    });
  }

  /**
   * Change the expiry — extend, shorten or clear it (`null` => permanent). A metadata edit, no actor.
   * `expiresAt` is informative: changing it never revokes or reactivates the grant (ADR-0023). 404
   * if missing.
   */
  async updateExpiry(id: string, data: UpdateAccessGrantExpiry) {
    await this.findOne(id);
    return this.prisma.accessGrant.update({
      where: { id },
      data: {
        expiresAt: data.expiresAt === null ? null : new Date(data.expiresAt),
      },
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * Resolve the optional `X-User-Id` actor: undefined/empty → undefined (system/unknown, leaves the
   * FK null). A present value must be a valid live user, else 400 (don't silently drop a bad id).
   */
  private async resolveActor(actorId?: string): Promise<string | undefined> {
    if (actorId === undefined || actorId === '') return undefined;
    if (!UUID_REGEX.test(actorId)) {
      throw new BadRequestException('X-User-Id is not a valid user id');
    }
    const user = await this.prisma.user.findFirst({
      where: { id: actorId, deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException(
        'X-User-Id does not reference a valid user',
      );
    }
    return user.id;
  }

  /** 400 if userId doesn't reference a live (non-soft-deleted) user. */
  private async assertUserUsable(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException(
        `userId ${userId} does not reference a live user`,
      );
    }
  }

  /** 400 if applicationId doesn't reference a live (non-soft-deleted) application. */
  private async assertApplicationUsable(applicationId: string): Promise<void> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId, deletedAt: null },
      select: { id: true },
    });
    if (!application) {
      throw new BadRequestException(
        `applicationId ${applicationId} does not reference a live application`,
      );
    }
  }
}
