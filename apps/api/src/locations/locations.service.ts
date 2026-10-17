import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateLocation,
  DeleteResolution,
  DeletedFilter,
  LocationBreadcrumb,
  LocationDeleteImpact,
  LocationType,
  PageQuery,
  UpdateLocation,
} from '@lazyit/shared';
import { DELETE_IMPACT_SAMPLE_LIMIT, offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectLocation } from '../search/search.documents';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { deleteResolutionRequired } from '../common/delete-resolution';
import {
  keysetOrderBy,
  keysetWhere,
  type KeysetCursor,
} from '../common/export';
import { ActorService, type ActorAttribution } from '../common/actor.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import { COUNTABLE_LINE_KINDS } from '../purchase-orders/purchase-order-derived';
import { recordPurchaseOrderEvents } from '../purchase-orders/purchase-order-events';
import { receivedUnitsSql } from '../purchase-orders/purchase-order-line-receipt';

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
 * Defensive cap on how deep the ancestry walk (breadcrumb resolution) will recurse. Real
 * location trees are shallow (site → room → rack); this only guards against a walk that never
 * terminates (which the cycle rule makes impossible, so hitting it signals a bug or corrupt data).
 */
const MAX_HIERARCHY_DEPTH = 32;

// Every tree-shape write checks and writes under this lock, or two opposing moves both pass and close a cycle.
export const LOCATION_TREE_LOCK = 'lazyit.location_tree';

/** A delete may re-point thousands of assets and write their history; allow it more than the 5 s default. */
export const LOCATION_DELETE_TX_TIMEOUT_MS = 30_000;

// Only these stored statuses still expect units; CANCELLED and any status a newer build adds keep their location.
const OPEN_PURCHASE_STATUSES = ['DRAFT', 'ORDERED'];

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
    private readonly permissions: PermissionResolverService,
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
        orderBy: [orderBy, { id: 'desc' }],
        take,
        skip,
        ...escapeHatch,
      }),
      this.prisma.location.count({ where, ...escapeHatch }),
    ]);
    return pageOf(items, total, page);
  }

  /** The CSV export's reads (ADR-0103): the list's own `where`, walked newest first by keyset. */
  exportSource(filters: LocationFilters, deleted: DeletedFilter) {
    const where: Prisma.LocationWhereInput = {
      ...this.buildWhere(filters),
      ...deletedWhere(deleted),
    };
    const escapeHatch: Record<string, unknown> = includeSoftDeletedFor(deleted)
      ? { includeSoftDeleted: true }
      : {};
    return {
      count: () => this.prisma.location.count({ where, ...escapeHatch }),
      fetchBatch: (after: KeysetCursor<string> | null, take: number) =>
        this.prisma.location.findMany({
          where: keysetWhere(where, after),
          orderBy: keysetOrderBy(),
          take,
          ...escapeHatch,
        }),
    };
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
    const { parentId } = data;
    const location =
      parentId == null
        ? await this.prisma.location.create({ data })
        : await this.prisma.$transaction(async (tx) => {
            await this.lockLocationTree(tx);
            await this.assertParentAssignable(tx, parentId);
            return tx.location.create({ data });
          });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('locations', projectLocation(location));
    return location;
  }

  async update(id: string, data: UpdateLocation) {
    // Re-parenting: reject a cycle (self or a descendant) and a missing/soft-deleted parent (400).
    // `parentId: null` (promote to root) is always allowed; an absent key leaves the parent untouched.
    const { parentId } = data;
    if (parentId === undefined) {
      await this.findOne(id); // 404 if missing or already soft-deleted
    }
    const location =
      parentId === undefined
        ? await this.prisma.location.update({ where: { id }, data })
        : await this.prisma.$transaction(async (tx) => {
            await this.lockLocationTree(tx);
            await this.assertLocationLive(tx, id);
            if (parentId !== null) {
              await this.assertParentAssignable(tx, parentId, id);
            }
            return tx.location.update({ where: { id }, data });
          });
    this.search.upsert('locations', projectLocation(location));
    return location;
  }

  /** What a delete would re-point or detach; item lists only for the kinds the caller may read. */
  async deleteImpact(
    id: string,
    principal?: Principal,
  ): Promise<LocationDeleteImpact> {
    await this.findOne(id);
    const [canAssets, canLocations, canPurchases] = await Promise.all([
      this.permissions.principalHas(principal, 'asset:read'),
      this.permissions.principalHas(principal, 'location:read'),
      this.permissions.principalHas(principal, 'purchaseOrder:read'),
    ]);
    const assetsWhere = { locationId: id, deletedAt: null };
    const childrenWhere = { parentId: id };
    const [assetTotal, assets, childTotal, children, purchases] =
      await Promise.all([
        this.prisma.asset.count({ where: assetsWhere }),
        canAssets
          ? this.prisma.asset.findMany({
              where: assetsWhere,
              select: { id: true, name: true, assetTag: true },
              orderBy: { name: 'asc' },
              take: DELETE_IMPACT_SAMPLE_LIMIT,
            })
          : null,
        this.prisma.location.count({ where: childrenWhere }),
        canLocations
          ? this.prisma.location.findMany({
              where: childrenWhere,
              select: { id: true, name: true, type: true },
              orderBy: { name: 'asc' },
              take: DELETE_IMPACT_SAMPLE_LIMIT,
            })
          : null,
        this.openPurchases(this.prisma, id),
      ]);
    return {
      assets: { total: assetTotal, items: assets },
      childLocations: { total: childTotal, items: children },
      purchaseOrders: {
        total: purchases.length,
        items: canPurchases
          ? purchases.slice(0, DELETE_IMPACT_SAMPLE_LIMIT)
          : null,
      },
    };
  }

  /** Soft delete; anything still pointing here needs the one `resolution`, applied in the same transaction. */
  async remove(
    id: string,
    resolution?: DeleteResolution,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    const location = await this.prisma.$transaction(
      async (tx) => {
        await this.lockLocationTree(tx);
        await this.assertLocationLive(tx, id);
        const assets = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "assets"
         WHERE "locationId" = ${id} AND "deletedAt" IS NULL
         ORDER BY "id" FOR UPDATE`;
        const children = await tx.location.findMany({
          where: { parentId: id },
          select: { id: true },
        });
        const purchases = await this.openPurchases(tx, id, true);
        if (assets.length + children.length + purchases.length > 0) {
          if (!resolution) {
            throw deleteResolutionRequired(`Location ${id}`, {
              assets: assets.length,
              childLocations: children.length,
              purchaseOrders: purchases.length,
            });
          }
          const to =
            resolution.strategy === 'move'
              ? await this.assertMoveTarget(tx, resolution.targetId, id)
              : null;
          await this.resolveDependents(tx, id, to, actor, {
            assetIds: assets.map((a) => a.id),
            childIds: children.map((c) => c.id),
            purchaseIds: purchases.map((p) => p.id),
          });
        }
        return tx.location.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
      },
      { timeout: LOCATION_DELETE_TX_TIMEOUT_MS },
    );
    // Drop from the index so soft-deleted locations never surface in search (ADR-0035).
    this.search.remove('locations', id);
    return location;
  }

  /**
   * Restore a soft-deleted location: clear `deletedAt` (ADR-0041). Finds the row via the
   * `includeSoftDeleted` escape hatch (the soft-delete read filter would hide it otherwise), 404s if
   * it never existed, and is idempotent if the row is already live. Re-indexes for search on success.
   * The partial unique index frees the name on delete, so a restore can collide with a row created in
   * the meantime — Prisma surfaces that as a 409 via the global PrismaExceptionFilter. A location whose
   * parent is still soft-deleted is a 409 too: restores do not cascade, so restore the parent first.
   */
  async restore(id: string) {
    const { restored, changed } = await this.prisma.$transaction(async (tx) => {
      await this.lockLocationTree(tx);
      const location = await tx.location.findFirst({
        where: { id },
        includeSoftDeleted: true,
      } as Prisma.LocationFindFirstArgs);
      if (!location) {
        throw new NotFoundException(`Location ${id} not found`);
      }
      if (location.deletedAt === null) {
        return { restored: location, changed: false }; // already live — idempotent
      }
      if (location.parentId !== null) {
        const parent = await tx.location.findFirst({
          where: { id: location.parentId },
          select: { id: true },
        });
        if (!parent) {
          throw new ConflictException(
            `Cannot restore location ${id}: its parent location ${location.parentId} is deleted. Restore the parent first.`,
          );
        }
      }
      const updated = await tx.location.update({
        where: { id },
        data: { deletedAt: null },
      });
      return { restored: updated, changed: true };
    });
    // Re-index the restored location (ADR-0035).
    if (changed) this.search.upsert('locations', projectLocation(restored));
    return restored;
  }

  // --- delete resolution (AUD-024) ------------------------------------------

  private async resolveDependents(
    tx: Prisma.TransactionClient,
    from: string,
    to: string | null,
    actor: ActorAttribution,
    rows: { assetIds: string[]; childIds: string[]; purchaseIds: string[] },
  ): Promise<void> {
    if (rows.assetIds.length > 0) {
      await tx.asset.updateMany({
        where: { id: { in: rows.assetIds } },
        data: { locationId: to },
      });
      await this.history.recordMany(
        tx,
        rows.assetIds.map((assetId) => ({
          assetId,
          eventType: 'LOCATION_CHANGED' as const,
          payload: { from, to },
          actor,
        })),
      );
    }
    if (rows.childIds.length > 0) {
      await tx.location.updateMany({
        where: { id: { in: rows.childIds } },
        data: { parentId: to },
      });
    }
    if (rows.purchaseIds.length > 0) {
      await tx.purchaseOrder.updateMany({
        where: { id: { in: rows.purchaseIds } },
        data: { deliveryLocationId: to },
      });
      await recordPurchaseOrderEvents(tx, rows.purchaseIds, 'UPDATED', actor, {
        fields: ['deliveryLocationId'],
        changes: { deliveryLocationId: { from, to } },
      });
    }
  }

  /** Live purchases delivering here in an open status with a pending countable line, or no countable line. */
  private async openPurchases(
    client: Prisma.TransactionClient | PrismaService,
    locationId: string,
    lock = false,
  ): Promise<{ id: string; reference: string | null }[]> {
    const countable = Prisma.sql`l."purchaseOrderId" = po."id" AND l."deletedAt" IS NULL
           AND l."kind" IN (${Prisma.join([...COUNTABLE_LINE_KINDS])})`;
    const rows = await client.$queryRaw<
      { id: string; reference: string | null; createdAt: Date }[]
    >`
      SELECT po."id", po."reference", po."createdAt" FROM "purchase_orders" po
       WHERE po."deliveryLocationId" = ${locationId}
         AND po."deletedAt" IS NULL
         AND po."status" IN (${Prisma.join(OPEN_PURCHASE_STATUSES)})
         AND (NOT EXISTS (SELECT 1 FROM "purchase_order_lines" l WHERE ${countable})
              OR EXISTS (SELECT 1 FROM "purchase_order_lines" l WHERE ${countable}
                           AND l."quantity" - l."cancelledQuantity" - ${receivedUnitsSql()} > 0))
       ORDER BY po."id" ASC
       ${lock ? Prisma.sql`FOR UPDATE OF po` : Prisma.empty}`;
    // Locked in id order like the model delete and supplier merge, so they cannot deadlock; listed oldest first.
    return rows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(({ id, reference }) => ({ id, reference }));
  }

  /** 400 unless the target is live, not the location being deleted, and not below it. */
  private async assertMoveTarget(
    tx: Prisma.TransactionClient,
    targetId: string,
    deletingId: string,
  ): Promise<string> {
    if (targetId === deletingId) {
      throw new BadRequestException(
        'Choose another location to move to, not the one being deleted.',
      );
    }
    const target = await tx.location.findFirst({
      where: { id: targetId },
      select: { id: true, parentId: true },
    });
    if (!target) {
      throw new BadRequestException(
        `Target location ${targetId} not found (missing or archived).`,
      );
    }
    if (await this.hasAncestor(tx, target, deletingId)) {
      throw new BadRequestException(
        'Cannot move to a location inside the one being deleted.',
      );
    }
    return target.id;
  }

  // --- hierarchy (#845) ----------------------------------------------------

  private async lockLocationTree(tx: Prisma.TransactionClient): Promise<void> {
    // $executeRaw: pg_advisory_xact_lock returns void, which Prisma's pg driver cannot deserialize.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCATION_TREE_LOCK}))`;
  }

  /** 404 if the location is missing or soft-deleted. */
  private async assertLocationLive(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<void> {
    const location = await tx.location.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException(`Location ${id} not found`);
    }
  }

  /**
   * Validate a proposed `parentId` for a location, inside the tree-lock transaction that then writes it.
   * Rejects (400) when the parent doesn't exist or is soft-deleted, and — the one hard structural rule —
   * when assigning it would create a CYCLE: `selfId` being its own parent, or a descendant of `selfId`.
   * Detects the cycle by walking UP from the proposed parent following `parentId`; if `selfId` shows up
   * anywhere in that chain, the parent is (transitively) below `selfId`, so the link would close a loop.
   * Only the parent itself must be live: the walk passes through soft-deleted ancestors (a live node may
   * sit under an archived one, as the read path tolerates), so an archived link cannot hide a loop that
   * its restore would close. The walk stops at a node it has already visited, so a corrupt loop above the
   * parent cannot spin it. `selfId` is omitted on create (the row doesn't exist yet, so no cycle is
   * possible — only the liveness check runs).
   */
  private async assertParentAssignable(
    tx: Prisma.TransactionClient,
    parentId: string,
    selfId?: string,
  ): Promise<void> {
    if (selfId && parentId === selfId) {
      throw new BadRequestException('A location cannot be its own parent.');
    }
    // Live rows only: a soft-deleted parent is not a valid parent.
    const parent = await tx.location.findFirst({
      where: { id: parentId },
      select: { id: true, parentId: true },
    });
    if (!parent) {
      throw new BadRequestException(`Parent location ${parentId} not found.`);
    }
    if (selfId && (await this.hasAncestor(tx, parent, selfId))) {
      throw new BadRequestException(
        'A location cannot be moved under one of its own descendants.',
      );
    }
  }

  /** Whether `ancestorId` is above `node`, walking through archived links and stopping on a loop. */
  private async hasAncestor(
    tx: Prisma.TransactionClient,
    node: { id: string; parentId: string | null },
    ancestorId: string,
  ): Promise<boolean> {
    const visited = new Set<string>([node.id]);
    let cursor = node.parentId;
    while (cursor && !visited.has(cursor)) {
      if (cursor === ancestorId) return true;
      visited.add(cursor);
      const next: { parentId: string | null } | null =
        await tx.location.findFirst({
          where: { id: cursor },
          select: { parentId: true },
          includeSoftDeleted: true,
        } as Prisma.LocationFindFirstArgs);
      cursor = next?.parentId ?? null;
    }
    return false;
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
