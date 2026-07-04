import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateLocation,
  LocationBreadcrumb,
  LocationType,
  PageQuery,
  UpdateLocation,
} from '@lazyit/shared';
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
  /** Restrict to locations of this type (OFFICE/DATACENTER/RACK/REMOTE/STORAGE/OTHER). */
  type?: LocationType;
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

/**
 * Defensive cap on how deep the hierarchy walk (cycle check / ancestry resolution) will recurse. Real
 * location trees are shallow (site → room → rack); this only guards against a walk that never
 * terminates (which the cycle rule makes impossible, so hitting it signals a bug or corrupt data).
 */
const MAX_HIERARCHY_DEPTH = 32;

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

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
  private buildWhere({ q, type }: LocationFilters): Prisma.LocationWhereInput {
    return {
      ...(type ? { type } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { address: { contains: q, mode: 'insensitive' } },
              { floor: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
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

  /**
   * A single location plus its resolved ancestry `path` (ordered root→self inclusive) for the detail
   * breadcrumb (#845). 404s like {@link findOne}; the path is a bounded parent-walk (cycle-free by
   * construction, so it always terminates well under the cap).
   */
  async findOneWithAncestors(id: string) {
    const location = await this.findOne(id);
    const path = await this.resolveAncestryPath(location);
    return { ...location, path };
  }

  async create(data: CreateLocation) {
    // Reject a bad parent BEFORE inserting (missing/soft-deleted → 400). No cycle is possible on
    // create — the new id doesn't exist yet, so it can't appear in the parent's ancestor chain.
    if (data.parentId != null) {
      await this.assertParentAssignable(data.parentId);
    }
    const location = await this.prisma.location.create({ data });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('locations', projectLocation(location));
    return location;
  }

  async update(id: string, data: UpdateLocation) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    // Re-parenting: reject a cycle (self or a descendant) and a missing/soft-deleted parent (400).
    // `parentId: null` (promote to root) is always allowed; an absent key leaves the parent untouched.
    if (data.parentId != null) {
      await this.assertParentAssignable(data.parentId, id);
    }
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

  // --- hierarchy (#845) ----------------------------------------------------

  /**
   * Validate a proposed `parentId` for a location. Rejects (400) when the parent doesn't exist or is
   * soft-deleted, and — the one hard structural rule — when assigning it would create a CYCLE:
   * `selfId` being its own parent, or a descendant of `selfId`. Detects the cycle by walking UP from
   * the proposed parent following `parentId`; if `selfId` shows up anywhere in that chain, the parent
   * is (transitively) below `selfId`, so the link would close a loop. `selfId` is omitted on create
   * (the row doesn't exist yet, so no cycle is possible — only the existence check runs).
   */
  private async assertParentAssignable(
    parentId: string,
    selfId?: string,
  ): Promise<void> {
    if (selfId && parentId === selfId) {
      throw new BadRequestException('A location cannot be its own parent.');
    }
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth++) {
      if (depth >= MAX_HIERARCHY_DEPTH) {
        // Unreachable while the tree stays acyclic — a safety net against corrupt data / a bug.
        this.logger.error(
          `Location hierarchy walk exceeded ${MAX_HIERARCHY_DEPTH} levels from parent ${parentId} (self ${selfId ?? 'n/a'}) — aborting to avoid a runaway loop.`,
        );
        throw new BadRequestException(
          'Location hierarchy is too deep to validate.',
        );
      }
      // Live rows only: a soft-deleted parent is not a valid parent.
      const node: { id: string; parentId: string | null } | null =
        await this.prisma.location.findFirst({
          where: { id: cursor },
          select: { id: true, parentId: true },
        });
      if (!node) {
        // The first miss is the proposed parent itself (bad input); a later miss is a broken chain.
        throw new BadRequestException(
          cursor === parentId
            ? `Parent location ${parentId} not found.`
            : `Broken parent chain at ${cursor}.`,
        );
      }
      if (node.id === selfId) {
        throw new BadRequestException(
          'A location cannot be moved under one of its own descendants.',
        );
      }
      cursor = node.parentId;
    }
  }

  /**
   * Resolve a location's ancestry into a breadcrumb ordered root→self INCLUSIVE. Bounded parent-walk
   * (cycle-free by construction). A soft-deleted ancestor (whose `parentId` was SET NULL on hard
   * delete, or is simply archived) ends the walk — the location is treated as a root from that break.
   */
  private async resolveAncestryPath(location: {
    id: string;
    name: string;
    type: LocationType;
    parentId: string | null;
  }): Promise<LocationBreadcrumb[]> {
    const chain: LocationBreadcrumb[] = [
      { id: location.id, name: location.name, type: location.type },
    ];
    let cursor = location.parentId;
    for (let depth = 0; cursor && depth < MAX_HIERARCHY_DEPTH; depth++) {
      const node: {
        id: string;
        name: string;
        type: LocationType;
        parentId: string | null;
      } | null = await this.prisma.location.findFirst({
        where: { id: cursor },
        select: { id: true, name: true, type: true, parentId: true },
      });
      if (!node) break; // soft-deleted / missing ancestor — stop here.
      chain.push({ id: node.id, name: node.name, type: node.type });
      cursor = node.parentId;
    }
    if (cursor) {
      this.logger.error(
        `Location ancestry walk for ${location.id} hit the ${MAX_HIERARCHY_DEPTH}-level cap — the tree may be corrupt (a cycle should be impossible).`,
      );
    }
    return chain.reverse();
  }
}
