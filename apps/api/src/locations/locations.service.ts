import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateLocation, PageQuery, UpdateLocation } from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectLocation } from '../search/search.documents';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';

/** Optional filters for listing locations. */
export interface LocationFilters {
  /** Case-insensitive substring over name / address / floor / description (OR). */
  q?: string;
}

/**
 * Server-side sort allowlist for `GET /locations` (ADR-0030 amendment). Maps each PUBLIC `?sort=` key
 * to the Prisma column. Unknown key → 400. With no `sort`, the list keeps its default `createdAt desc`.
 */
export const LOCATION_SORT_ALLOWLIST = {
  name: 'name',
  type: 'type',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  /**
   * A single page of locations (default `createdAt desc`). Server-side `q` search (over
   * name/address/floor/description) and an allowlisted sort make the list authoritative — migrated
   * off the raw-array contract that filtered client-side and silently truncated past the window
   * (ADR-0030). The `deleted` slice (`active` default | `only`) scopes the page to live or
   * soft-deleted rows; `only` carries the ADR-0032 `includeSoftDeleted` escape hatch so the read
   * filter doesn't re-hide them (ADMIN-gated at the controller). Runs `findMany(take/skip)` + `count`
   * over the same `where` in one `$transaction`.
   */
  async findPage(filters: LocationFilters, page: PageQuery) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.LocationOrderByWithRelationInput>(
        page,
        LOCATION_SORT_ALLOWLIST,
      ) ??
      ({ createdAt: 'desc' } satisfies Prisma.LocationOrderByWithRelationInput);
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object rather than fighting the type.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.location.findMany({
        where,
        orderBy,
        take,
        skip,
        ...escapeHatch,
      }),
      this.prisma.location.count({ where, ...escapeHatch }),
    ]);
    return pageOf(items, total, page);
  }

  /** The shared `where` for the location list — used identically by findPage and its count. */
  private buildWhere({ q }: LocationFilters): Prisma.LocationWhereInput {
    return q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { address: { contains: q, mode: 'insensitive' } },
            { floor: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};
  }

  /** A single non-deleted location by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const location = await this.prisma.location.findFirst({
      where: { id },
    });
    if (!location) {
      throw new NotFoundException(`Location ${id} not found`);
    }
    return location;
  }

  async create(data: CreateLocation) {
    const location = await this.prisma.location.create({ data });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('locations', projectLocation(location));
    return location;
  }

  async update(id: string, data: UpdateLocation) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const location = await this.prisma.location.update({ where: { id }, data });
    this.search.upsert('locations', projectLocation(location));
    return location;
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.findOne(id);
    const location = await this.prisma.location.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Drop from the index so soft-deleted locations never surface in search (ADR-0035).
    this.search.remove('locations', id);
    return location;
  }

  /**
   * Restore a soft-deleted location: clear `deletedAt` (ADR-0041). Finds the row via the
   * `includeSoftDeleted` escape hatch (the soft-delete read filter would hide it otherwise), 404s if
   * it never existed, and is idempotent if the row is already live. Re-indexes for search on success.
   * The partial unique index frees the name on delete, so a restore can collide with a row created in
   * the meantime — Prisma surfaces that as a 409 via the global PrismaExceptionFilter.
   */
  async restore(id: string) {
    const location = await this.prisma.location.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.LocationFindFirstArgs);
    if (!location) {
      throw new NotFoundException(`Location ${id} not found`);
    }
    if (location.deletedAt === null) {
      return location; // already live — idempotent
    }
    const restored = await this.prisma.location.update({
      where: { id },
      data: { deletedAt: null },
    });
    // Re-index the restored location (ADR-0035).
    this.search.upsert('locations', projectLocation(restored));
    return restored;
  }
}
