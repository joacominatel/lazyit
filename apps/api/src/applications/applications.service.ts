import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateApplication,
  PageQuery,
  UpdateApplication,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectApplication } from '../search/search.documents';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';

/** Optional filters for listing applications. */
export interface ApplicationFilters {
  /** Case-insensitive substring over name / vendor / url / description (OR). */
  q?: string;
}

/**
 * Server-side sort allowlist for `GET /applications` (ADR-0030 amendment). Maps each PUBLIC `?sort=`
 * key to the Prisma column. Unknown key → 400. With no `sort`, the list keeps its default `name asc`.
 */
export const APPLICATION_SORT_ALLOWLIST = {
  name: 'name',
  vendor: 'vendor',
  isCritical: 'isCritical',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  /**
   * A single page of applications (default `name asc`). Server-side `q` search (over
   * name/vendor/url/description) and an allowlisted sort make the list authoritative — migrated off
   * the raw-array contract that filtered client-side and silently truncated past the window
   * (ADR-0030). The `deleted` slice (`active` default | `only`) scopes the page to live or
   * soft-deleted rows; `only` carries the ADR-0032 `includeSoftDeleted` escape hatch so the read
   * filter doesn't re-hide them (ADMIN-gated at the controller). Runs `findMany(take/skip)` + `count`
   * over the same `where` in one `$transaction`.
   */
  async findPage(filters: ApplicationFilters, page: PageQuery) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.ApplicationOrderByWithRelationInput>(
        page,
        APPLICATION_SORT_ALLOWLIST,
      ) ??
      ({ name: 'asc' } satisfies Prisma.ApplicationOrderByWithRelationInput);
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object rather than fighting the type.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.application.findMany({
        where,
        orderBy,
        take,
        skip,
        ...escapeHatch,
      }),
      this.prisma.application.count({ where, ...escapeHatch }),
    ]);
    // Derived license seats (#949): ONE distinct query for the whole page, folded in memory — no
    // per-row fan-out (N+1). Absent app → 0 seats used.
    const seatsUsed = await this.seatsUsedByApplication(
      items.map((application) => application.id),
    );
    const withSeats = items.map((application) => ({
      ...application,
      seatsUsed: seatsUsed.get(application.id) ?? 0,
    }));
    return pageOf(withSeats, total, page);
  }

  /**
   * `seatsUsed` per application (#949, ADR-0088): the DISTINCT count of users holding an ACTIVE
   * (`revokedAt: null`) grant on each app. Grants are deliberately multi-grant — a user may hold
   * several active grants on one app at different accessLevels (ADR-0023) — so a raw grant count
   * over-reports the license; DISTINCT user is the correct seat math. ONE query for the whole set
   * (distinct `(applicationId, userId)` pairs over the `access_grants(applicationId)` index), folded in
   * memory — never a per-row query. Apps with no active grant are simply absent from the map (→ 0).
   */
  private async seatsUsedByApplication(
    ids: string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const pairs = await this.prisma.accessGrant.findMany({
      where: { revokedAt: null, applicationId: { in: ids } },
      select: { applicationId: true, userId: true },
      distinct: ['applicationId', 'userId'],
    });
    const counts = new Map<string, number>();
    for (const { applicationId } of pairs) {
      counts.set(applicationId, (counts.get(applicationId) ?? 0) + 1);
    }
    return counts;
  }

  /** The shared `where` for the application list — used identically by findPage and its count. */
  private buildWhere({ q }: ApplicationFilters): Prisma.ApplicationWhereInput {
    return q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { vendor: { contains: q, mode: 'insensitive' } },
            { url: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};
  }

  /**
   * A single non-deleted application by id; throws 404 if missing or deleted. Carries the derived
   * `seatsUsed` (#949) so the detail read renders "used / purchased" without a second round-trip.
   */
  async findOne(id: string) {
    const application = await this.prisma.application.findFirst({
      where: { id },
    });
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    const seatsUsed = await this.seatsUsedByApplication([application.id]);
    return { ...application, seatsUsed: seatsUsed.get(application.id) ?? 0 };
  }

  async create(data: CreateApplication) {
    const { metadata, ...rest } = data;
    const application = await this.prisma.application.create({
      data: {
        ...rest,
        ...(metadata !== undefined
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('applications', projectApplication(application));
    return application;
  }

  async update(id: string, data: UpdateApplication) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const { metadata, ...rest } = data;
    const application = await this.prisma.application.update({
      where: { id },
      data: {
        ...rest,
        ...(metadata !== undefined
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    this.search.upsert('applications', projectApplication(application));
    return application;
  }

  /**
   * Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). Existing
   * grants are preserved and keep pointing here; the FK `Restrict` is only a hard-delete safety
   * net — soft delete bypasses it (ADR-0023).
   */
  async remove(id: string) {
    await this.findOne(id);
    const application = await this.prisma.application.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Drop from the index so soft-deleted applications never surface in search (ADR-0035).
    this.search.remove('applications', id);
    return application;
  }

  /**
   * Restore a soft-deleted application: clear `deletedAt` (ADR-0041). Found via the
   * `includeSoftDeleted` escape hatch (the read filter would hide it). 404 if it never existed;
   * idempotent if already live. Re-indexes for search on success.
   */
  async restore(id: string) {
    const application = await this.prisma.application.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.ApplicationFindFirstArgs);
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    if (application.deletedAt === null) {
      return application; // already live — idempotent
    }
    const restored = await this.prisma.application.update({
      where: { id },
      data: { deletedAt: null },
    });
    // Re-index the restored application (ADR-0035).
    this.search.upsert('applications', projectApplication(restored));
    return restored;
  }
}
