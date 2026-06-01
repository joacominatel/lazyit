import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateAccessGrant,
  PageQuery,
  RevokeAccessGrant,
  UpdateAccessGrantExpiry,
  UpdateAccessGrantNotes,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';

/** Filters for listing grants. `activeOnly` / `includeExpired` default to true (set at the controller). */
export interface FindAccessGrantsFilters {
  userId?: string;
  applicationId?: string;
  activeOnly?: boolean;
  includeExpired?: boolean;
}

/**
 * AccessGrant — the User↔Application access join (append-only, revoked via `revokedAt`; ADR-0023).
 * The actor (`grantedById` on create, `revokedById` on revoke) comes from the authenticated User
 * resolved by JwtAuthGuard (@CurrentUser()) — never the request body (ADR-0022/0024/0038).
 */
@Injectable()
export class AccessGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
  ) {}

  /**
   * Grants, newest first. Filters: user, application, `activeOnly` (only `revokedAt = null`,
   * default true) and `includeExpired` (default true; when false, hides grants already past their
   * `expiresAt`). `expiresAt` never changes activeness — it's informative (ADR-0023).
   *
   * Unpaginated — still used by the inherently-scoped nested lists (`/users/:id/access-grants`,
   * `/applications/:id/access-grants`). The top-level `GET /access-grants` uses {@link findPage}.
   */
  findAll(filters: FindAccessGrantsFilters) {
    return this.prisma.accessGrant.findMany({
      where: this.buildWhere(filters),
      orderBy: { grantedAt: 'desc' },
    });
  }

  /**
   * A single page of grants (newest first) for the top-level `GET /access-grants` — the most
   * sensitive unbounded list (ADR-0030/SEC-007). Runs the page `findMany(take/skip)` and the `count`
   * over the **same** `where` inside one `$transaction`, so the `total` can't drift from the page
   * under concurrent inserts/revokes. Same filters as {@link findAll}.
   */
  async findPage(filters: FindAccessGrantsFilters, page: PageQuery) {
    const where = this.buildWhere(filters);
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.accessGrant.findMany({
        where,
        orderBy: { grantedAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.accessGrant.count({ where }),
    ]);
    // The Prisma rows carry `Date`s; the API serializes them to the ISO-string wire shape at the
    // HTTP boundary (same as findAll/findOne) — the AccessGrantListPage DTO documents that shape.
    return pageOf(items, total, page);
  }

  /** The shared `where` for the grant lists — used identically by findAll, findPage and its count. */
  private buildWhere({
    userId,
    applicationId,
    activeOnly = true,
    includeExpired = true,
  }: FindAccessGrantsFilters): Prisma.AccessGrantWhereInput {
    return {
      ...(userId ? { userId } : {}),
      ...(applicationId ? { applicationId } : {}),
      ...(activeOnly ? { revokedAt: null } : {}),
      ...(includeExpired
        ? {}
        : { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }),
    };
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
   * authenticated User when present (null = system/unknown).
   */
  async create(data: CreateAccessGrant, user?: User) {
    const grantedById = this.actor.resolve(user);
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
   * Revoke an active grant: set `revokedAt = now()` (+ `revokedById` from the authenticated User,
   * optional `notes`). 404 if missing; 409 if already revoked (revoke is not repeatable). Revoking
   * one grant does not affect any other grant the same user holds on the same application.
   */
  async revoke(id: string, data: RevokeAccessGrant, user?: User) {
    const grant = await this.findOne(id);
    if (grant.revokedAt !== null) {
      throw new ConflictException(`AccessGrant ${id} is already revoked`);
    }
    const revokedById = this.actor.resolve(user);
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

  /** 400 if userId doesn't reference a live (non-soft-deleted) user. */
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

  /** 400 if applicationId doesn't reference a live (non-soft-deleted) application. */
  private async assertApplicationUsable(applicationId: string): Promise<void> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) {
      throw new BadRequestException(
        `applicationId ${applicationId} does not reference a live application`,
      );
    }
  }
}
