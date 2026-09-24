import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  ConsumableDeliveryTarget,
  ConsumableDeliveryTargetKey,
  CreateConsumable,
  CreateConsumableMovement,
  PageQuery,
  Permission,
  UpdateConsumable,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import type { ActorAttribution } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { NotificationsService } from '../notifications/notifications.service';
import { SearchService } from '../search/search.service';
import { projectConsumable } from '../search/search.documents';

/**
 * PostgreSQL `int4` upper bound — the max value a Prisma `Int` column (here `currentStock`) can
 * hold. A computed stock above this would overflow the column at write time (Prisma P2020), so we
 * reject it as a 409 before touching the row. Mirrors `INT4_MAX` in `@lazyit/shared` primitives.
 */
const INT4_MAX = 2_147_483_647;

/** Optional filters for listing consumables. */
export interface ConsumableFilters {
  /** When true, return only items at or below their reorder threshold (minStock set). */
  lowStock?: boolean;
  /** Case-insensitive substring over name / sku / description (OR). */
  q?: string;
  /** Restrict to consumables in this category (ConsumableCategory id, a cuid). */
  categoryId?: string;
}

/**
 * Server-side sort allowlist for `GET /consumables` (ADR-0030 amendment). Maps each PUBLIC `?sort=`
 * key to the Prisma column. Unknown key → 400. With no `sort`, the list keeps its default `name asc`.
 */
export const CONSUMABLE_SORT_ALLOWLIST = {
  name: 'name',
  sku: 'sku',
  currentStock: 'currentStock',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

/** Optional filters for a consumable's movement ledger. */
export interface MovementFilters {
  type?: CreateConsumableMovement['type'];
  /** Inclusive lower bound on createdAt (ISO datetime string). */
  from?: string;
  /** Inclusive upper bound on createdAt (ISO datetime string). */
  to?: string;
}

/** The three kinds of delivery destination (ADR-0098). */
type TargetKind = ConsumableDeliveryTarget['type'];

/** Target column → kind, and the read permission a caller needs to SEE (or list by) that kind. */
const TARGET_KIND: Record<ConsumableDeliveryTargetKey, TargetKind> = {
  targetUserId: 'user',
  targetAssetId: 'asset',
  targetLocationId: 'location',
};
const TARGET_READ_PERMISSION: Record<TargetKind, Permission> = {
  user: 'user:read',
  asset: 'asset:read',
  location: 'location:read',
};

/** A requested delivery target: which column, which kind, which id. */
interface TargetRef {
  key: ConsumableDeliveryTargetKey;
  kind: TargetKind;
  id: string;
}

/** The delivery-related columns of a movement row, as the target resolver reads them. */
interface TargetColumns {
  targetUserId?: string | null;
  targetAssetId?: string | null;
  targetLocationId?: string | null;
}

/** Which target kinds the caller may see resolved (display fields) — ADR-0098 redaction. */
type ReadableKinds = Record<TargetKind, boolean>;

/** Filters for `GET /consumables/deliveries` (the parsed ConsumableDeliveryQuery). */
export interface DeliveryFilters {
  targetUserId?: string;
  targetAssetId?: string;
  targetLocationId?: string;
  outstandingOnly: boolean;
  from?: string;
  to?: string;
}

/** The one target a create payload or a deliveries query names, or null (validated upstream). */
function targetOf(data: TargetColumns): TargetRef | null {
  for (const key of Object.keys(TARGET_KIND) as ConsumableDeliveryTargetKey[]) {
    const id = data[key];
    if (id != null) {
      return { key, kind: TARGET_KIND[key], id };
    }
  }
  return null;
}

@Injectable()
export class ConsumablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly notifications: NotificationsService,
    // The asset timeline (ADR-0033): a delivery to / return from an ASSET appends CONSUMABLE_DELIVERED /
    // CONSUMABLE_RETURNED in the movement's own transaction (ADR-0098).
    private readonly history: AssetHistoryService,
    // Target redaction + the per-kind gate on the deliveries list (ADR-0098, mirroring ADR-0046 P3).
    private readonly permissions: PermissionResolverService,
    // Best-effort search sync (ADR-0035). @Global SearchModule always provides it at runtime (no module
    // import needed); @Optional so unit suites that construct the service directly needn't wire a search
    // double, and every call site null-guards (`this.search?.`) so an absent client simply no-ops.
    @Optional() private readonly search?: SearchService,
  ) {}

  /**
   * A single page of consumables (default `name asc`). Server-side `q` search (over
   * name/sku/description) and an allowlisted sort make the list authoritative — migrated off the
   * raw-array contract that filtered client-side and silently truncated past the window (ADR-0030).
   * The `lowStock` filter is preserved (items at or below their reorder threshold — a column-to-column
   * comparison via the Prisma field reference). The `deleted` slice (`active` default | `only`)
   * scopes the page to live or soft-deleted rows; the `deletedAt` clause is applied EXPLICITLY here
   * (the Consumable model is not in the ADR-0032 SOFT_DELETABLE_MODELS set, so the read filter does
   * NOT auto-scope it). `only` is ADMIN-gated at the controller. Runs `findMany(take/skip)` + `count`
   * over the same `where` in one `$transaction`.
   */
  async findPage(filters: ConsumableFilters, page: PageQuery) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.ConsumableOrderByWithRelationInput>(
        page,
        CONSUMABLE_SORT_ALLOWLIST,
      ) ??
      ({ name: 'asc' } satisfies Prisma.ConsumableOrderByWithRelationInput);
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object rather than fighting the type.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.consumable.findMany({
        where,
        orderBy,
        take,
        skip,
        ...escapeHatch,
      }),
      this.prisma.consumable.count({ where, ...escapeHatch }),
    ]);
    return pageOf(items, total, page);
  }

  /** The shared `where` for the consumable list — used identically by findPage and its count. */
  private buildWhere({
    lowStock,
    q,
    categoryId,
  }: ConsumableFilters): Prisma.ConsumableWhereInput {
    return {
      ...(categoryId ? { categoryId } : {}),
      ...(lowStock
        ? {
            minStock: { not: null },
            currentStock: { lte: this.prisma.consumable.fields.minStock },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { sku: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  /**
   * A single non-deleted consumable by id; throws 404 if missing or deleted. `Consumable` is NOT in
   * the ADR-0032 SOFT_DELETABLE_MODELS set (its service filters `deletedAt` explicitly to serve the
   * ADMIN archived-view slice), so the read filter does NOT auto-scope it — the `deletedAt: null`
   * guard is applied here EXPLICITLY (SEC-050).
   */
  async findOne(id: string) {
    const consumable = await this.prisma.consumable.findFirst({
      where: { id, deletedAt: null },
    });
    if (!consumable) {
      throw new NotFoundException(`Consumable ${id} not found`);
    }
    return consumable;
  }

  /**
   * Create. `currentStock` is never set here — it starts at the schema default (0) and only moves
   * through movements (ADR-0034). Invalid categoryId hits the FK and is mapped to 400. Now `async` so
   * the fire-and-forget search sync can fire on the created row (#873).
   */
  async create(data: CreateConsumable) {
    const consumable = await this.prisma.consumable.create({ data });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search?.upsert('consumables', projectConsumable(consumable));
    return consumable;
  }

  /** Partial update. `currentStock` is not updatable here. 404 if missing or already soft-deleted. */
  async update(id: string, data: UpdateConsumable) {
    await this.assertExists(id);
    const consumable = await this.prisma.consumable.update({
      where: { id },
      data,
    });
    this.search?.upsert('consumables', projectConsumable(consumable));
    return consumable;
  }

  /** Soft delete: set deletedAt (never hard-delete; movements keep the FK alive). */
  async remove(id: string) {
    await this.assertExists(id);
    const consumable = await this.prisma.consumable.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Drop from the index so a soft-deleted consumable never surfaces in search (ADR-0035).
    this.search?.remove('consumables', id);
    return consumable;
  }

  /**
   * Restore a soft-deleted consumable: clear `deletedAt` (ADR-0041). Found via the
   * `includeSoftDeleted` escape hatch (the read filter would hide it). 404 if it never existed;
   * idempotent if already live. The partial unique index frees `sku` on delete, so a restore can 409
   * if another live consumable took the sku in the meantime (mapped by the PrismaExceptionFilter).
   */
  async restore(id: string) {
    const consumable = await this.prisma.consumable.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.ConsumableFindFirstArgs);
    if (!consumable) {
      throw new NotFoundException(`Consumable ${id} not found`);
    }
    if (consumable.deletedAt === null) {
      return consumable; // already live — idempotent
    }
    const restored = await this.prisma.consumable.update({
      where: { id },
      data: { deletedAt: null },
    });
    // Re-index the restored consumable (ADR-0035).
    this.search?.upsert('consumables', projectConsumable(restored));
    return restored;
  }

  /**
   * Record a stock movement and adjust the cached `currentStock` atomically (ADR-0034), in the same
   * transaction as the ledger insert so the cache and the ledger never diverge. The actor comes from
   * the unified PRINCIPAL (a human → `performedById`, a service account → `serviceAccountId`; ADR-0048).
   *
   * The cache write is done with **atomic, conditional SQL** rather than a JS read-modify-write, so
   * two concurrent movements can't lost-update each other under Read Committed:
   *   - IN          → `increment` (a single `UPDATE ... SET currentStock = currentStock + qty`),
   *                   after a live-scoped pre-read (404s a missing/soft-deleted row; SEC-050).
   *   - OUT         → a **guarded** `updateMany` that decrements only while `currentStock >= qty`
   *                   (and the row is live); if it matches 0 rows the stock is insufficient (or the
   *                   row vanished) → **409**, and the whole transaction rolls back.
   *   - ADJUSTMENT  → set `currentStock` to the absolute `quantity` (a physical recount) via a
   *                   **guarded** `updateMany` scoped to the live row; no match ⇒ **404** (SEC-050).
   *
   * Overflow guard: an IN whose result would exceed int4 (`> INT4_MAX`) is rejected as a **409**
   * before any write, so the cache can never silently wrap or hit a P2020 mid-transaction. Returns
   * the ledger row.
   */
  async createMovement(
    consumableId: string,
    data: CreateConsumableMovement,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    const { type, quantity, reason, notes, returnOfId } = data;
    const target = targetOf(data);
    // Defense in depth (the shared schema already rejects these with a 400 at the DTO; the service is
    // also reachable in-process): a target only on OUT, a return only on IN (ADR-0098). The DB CHECKs are
    // the last backstop.
    if (target && type !== 'OUT') {
      throw new BadRequestException(
        'A delivery target is only allowed on an OUT movement',
      );
    }
    if (returnOfId !== undefined && type !== 'IN') {
      throw new BadRequestException(
        'returnOfId (a return) is only allowed on an IN movement',
      );
    }

    // BEFORE-snapshot (live row only) for the low-stock crossing check (ADR-0056 §3). A light read
    // outside the tx; null when the row is missing/soft-deleted (the tx below 404s those). The crossing
    // is computed from this `before` stock vs the `after` re-read once the tx commits.
    const before = await this.prisma.consumable.findFirst({
      where: { id: consumableId, deletedAt: null },
      select: { currentStock: true, minStock: true, name: true },
    });

    const movement = await this.prisma.$transaction(async (tx) => {
      // A delivery must name a LIVE destination: a missing or soft-deleted user / asset / location is a
      // client error (400), not a 500 at the FK — mirrors AssetAssignmentsService's live-row guard. The
      // `deletedAt: null` is explicit even though User/Asset/Location are in the ADR-0032 auto-filtered set.
      if (target) {
        await this.assertTargetLive(tx, target);
      }
      // A return: lock + validate the delivery it gives back BEFORE the stock moves (race-safe).
      const delivery =
        returnOfId !== undefined
          ? await this.lockReturnableDelivery(
              tx,
              consumableId,
              returnOfId,
              quantity,
            )
          : null;

      // The consumable's name/unit, read only when an asset-history event will need them.
      let snapshot: {
        name: string;
        unit: string;
        returnable: boolean;
      } | null = null;

      if (type === 'IN') {
        // Read only to enforce the int4 ceiling and a clean 404; the write itself is atomic. Scoped
        // to the LIVE row (`deletedAt: null`) so a soft-deleted consumable reads as null → 404 and is
        // never incremented — `Consumable` is not auto-filtered by the ADR-0032 extension (SEC-050).
        const consumable = await tx.consumable.findFirst({
          where: { id: consumableId, deletedAt: null },
          select: delivery
            ? { currentStock: true, name: true, unit: true }
            : { currentStock: true },
        });
        if (!consumable) {
          throw new NotFoundException(`Consumable ${consumableId} not found`);
        }
        if (consumable.currentStock + quantity > INT4_MAX) {
          throw new ConflictException(
            `Stock would exceed the maximum of ${INT4_MAX}`,
          );
        }
        await tx.consumable.update({
          where: { id: consumableId },
          data: { currentStock: { increment: quantity } },
        });
        if (delivery) {
          const named = consumable as { name: string; unit: string };
          snapshot = { name: named.name, unit: named.unit, returnable: false };
        }
      } else if (type === 'OUT') {
        // Guarded decrement: only succeeds while the live row still has enough stock. This is the
        // atomic check-and-act that closes the lost-update race — no row matched ⇒ 409 + rollback.
        const result = await tx.consumable.updateMany({
          where: {
            id: consumableId,
            deletedAt: null,
            currentStock: { gte: quantity },
          },
          data: { currentStock: { decrement: quantity } },
        });
        if (result.count === 0) {
          // Distinguish "no such (live) consumable" (404) from "not enough stock" (409). Live-scoped
          // (`deletedAt: null`) so a soft-deleted consumable reads as null → 404, never echoing an
          // archived row's exact stock in the 409 message (info leak; SEC-050).
          const consumable = await tx.consumable.findFirst({
            where: { id: consumableId, deletedAt: null },
            select: { currentStock: true },
          });
          if (!consumable) {
            throw new NotFoundException(`Consumable ${consumableId} not found`);
          }
          throw new ConflictException(
            `Insufficient stock: have ${consumable.currentStock}, cannot remove ${quantity}`,
          );
        }
        if (target) {
          // The returnable SNAPSHOT (ADR-0098): read AFTER the guarded decrement, so this transaction
          // already holds the consumable's row lock — a concurrent PATCH toggling `returnable` waits for
          // us, and the flag stamped on the delivery is the one in force when the units left.
          snapshot = await tx.consumable.findFirst({
            where: { id: consumableId, deletedAt: null },
            select: { name: true, unit: true, returnable: true },
          });
          if (!snapshot) {
            throw new NotFoundException(`Consumable ${consumableId} not found`);
          }
        }
      } else {
        // ADJUSTMENT: an absolute recount. quantity is bounded to int4 by the shared schema, so no
        // overflow is possible here. A guarded `updateMany` scoped to the live row (`deletedAt: null`)
        // — a plain `update` only 404s (P2025) when the row is truly absent, NOT when it is merely
        // soft-deleted (the row still exists), which would silently recount an archived consumable
        // (SEC-050). No matched row ⇒ missing or soft-deleted ⇒ 404 + rollback.
        const result = await tx.consumable.updateMany({
          where: { id: consumableId, deletedAt: null },
          data: { currentStock: quantity },
        });
        if (result.count === 0) {
          throw new NotFoundException(`Consumable ${consumableId} not found`);
        }
      }

      const created = await tx.consumableMovement.create({
        data: {
          consumableId,
          type,
          quantity,
          ...(reason !== undefined ? { reason } : {}),
          ...(notes !== undefined ? { notes } : {}),
          // Attribute the movement: human → performedById, service account → serviceAccountId. CHECK-safe
          // by construction (resolveActor returns at most one of the pair; ADR-0048).
          ...(actor.userId != null ? { performedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { serviceAccountId: actor.serviceAccountId }
            : {}),
          // Delivery (ADR-0098): the one target + the returnable snapshot (a targeted OUT only).
          ...(target ? { [target.key]: target.id } : {}),
          ...(target && snapshot?.returnable ? { returnable: true } : {}),
          // Return: the delivery this IN gives back.
          ...(delivery ? { returnOfId: delivery.id } : {}),
        },
      });

      // The asset's own timeline, in THIS transaction (ADR-0033): a delivery to an asset, or a return of
      // one. A user / location target writes no asset event (their record is the deliveries read).
      const assetId =
        target?.kind === 'asset' ? target.id : delivery?.targetAssetId;
      if (assetId && snapshot) {
        await this.recordAssetEvent(tx, {
          assetId,
          eventType: delivery ? 'CONSUMABLE_RETURNED' : 'CONSUMABLE_DELIVERED',
          consumableId,
          consumable: snapshot,
          movementId: created.id,
          quantity,
          returnOfId: delivery?.id,
          actor,
        });
      }
      return created;
    });

    // AFTER commit, best-effort: a low-stock bell nudge on a DOWNWARD crossing (ADR-0056 §3) — NEVER
    // inside the tx (a notification must not roll back the movement).
    await this.emitLowStock(consumableId, before);
    // Keep the indexed `currentStock` fresh (#873): stock only moves through movements, so re-index the
    // consumable after the movement commits. Fire-and-forget (`void`) — a search hiccup never fails the
    // movement, and the read/upsert are best-effort inside {@link reindex}.
    void this.reindex(consumableId);
    return movement;
  }

  /**
   * 400 unless the delivery target is a LIVE row (ADR-0098). Runs on the transaction client. Soft-deleted
   * rows read as null (explicit `deletedAt: null`), so a delivery to an offboarded user, a retired asset
   * or an archived location is refused — history can still be listed, new deliveries cannot be made.
   */
  private async assertTargetLive(
    tx: Prisma.TransactionClient,
    target: TargetRef,
  ): Promise<void> {
    const where = { id: target.id, deletedAt: null };
    const select = { id: true } as const;
    const found =
      target.kind === 'user'
        ? await tx.user.findFirst({ where, select })
        : target.kind === 'asset'
          ? await tx.asset.findFirst({ where, select })
          : await tx.location.findFirst({ where, select });
    if (!found) {
      throw new BadRequestException(
        `${target.key} ${target.id} does not reference a live ${target.kind}`,
      );
    }
  }

  /**
   * Validate a RETURN against the delivery it names and LOCK that delivery row (ADR-0098). The row lock
   * (`SELECT … FOR UPDATE` on `consumable_movements`) is taken FIRST, so two concurrent returns of the same
   * delivery serialize: the second waits for the first to commit and then sums a return set that already
   * includes it — it can never over-return. Rules:
   *   - the delivery must exist and belong to THIS consumable → else 400 (one message for both, so a
   *     caller cannot probe another consumable's ledger);
   *   - it must be a delivery (a targeted OUT) → else 400;
   *   - it must have been returnable WHEN MADE (the snapshot, not today's flag) → else 400;
   *   - `quantity` ≤ outstanding (delivery.quantity − SUM(its returns)) → else 409 (state, not shape).
   * The caller's IN path then puts the units back as a normal IN (int4 ceiling included).
   */
  private async lockReturnableDelivery(
    tx: Prisma.TransactionClient,
    consumableId: string,
    returnOfId: number,
    quantity: number,
  ): Promise<{ id: number; targetAssetId: string | null }> {
    await tx.$queryRaw`SELECT "id" FROM "consumable_movements" WHERE "id" = ${returnOfId} FOR UPDATE`;
    const delivery = await tx.consumableMovement.findFirst({
      where: { id: returnOfId },
      select: {
        id: true,
        consumableId: true,
        type: true,
        quantity: true,
        returnable: true,
        targetUserId: true,
        targetAssetId: true,
        targetLocationId: true,
      },
    });
    if (!delivery || delivery.consumableId !== consumableId) {
      throw new BadRequestException(
        `returnOfId ${returnOfId} is not a delivery of this consumable`,
      );
    }
    if (delivery.type !== 'OUT' || targetOf(delivery) === null) {
      throw new BadRequestException(
        `Movement ${returnOfId} is not a delivery (an OUT with a target); only a delivery can be returned`,
      );
    }
    if (!delivery.returnable) {
      throw new BadRequestException(
        `Delivery ${returnOfId} was not returnable when it was made; it cannot be returned`,
      );
    }
    const returned = await tx.consumableMovement.aggregate({
      where: { returnOfId },
      _sum: { quantity: true },
    });
    const outstanding = delivery.quantity - (returned._sum.quantity ?? 0);
    if (quantity > outstanding) {
      throw new ConflictException(
        `Cannot return ${quantity}: only ${outstanding} outstanding on delivery ${returnOfId}`,
      );
    }
    return { id: delivery.id, targetAssetId: delivery.targetAssetId };
  }

  /**
   * Append CONSUMABLE_DELIVERED / CONSUMABLE_RETURNED to an asset's timeline on the movement's transaction
   * client (ADR-0098 / ADR-0033). Payload `{ consumableId, consumableName, movementId, quantity, unit }`
   * (+ `returnOfId` on a return). The actor is the movement's principal (human XOR service account), and
   * {@link AssetHistoryService.record} stamps `aiInvocationId` when an AI tool made the call.
   */
  private recordAssetEvent(
    tx: Prisma.TransactionClient,
    event: {
      assetId: string;
      eventType: 'CONSUMABLE_DELIVERED' | 'CONSUMABLE_RETURNED';
      consumableId: string;
      consumable: { name: string; unit: string };
      movementId: number;
      quantity: number;
      returnOfId?: number;
      actor: ActorAttribution;
    },
  ): Promise<unknown> {
    return this.history.record(tx, {
      assetId: event.assetId,
      eventType: event.eventType,
      payload: {
        consumableId: event.consumableId,
        consumableName: event.consumable.name,
        movementId: event.movementId,
        quantity: event.quantity,
        unit: event.consumable.unit,
        ...(event.returnOfId !== undefined
          ? { returnOfId: event.returnOfId }
          : {}),
      },
      actor: event.actor,
    });
  }

  /**
   * Re-index a consumable from its current live row (#873). Best-effort (ADR-0035): reads the live row
   * and upserts its projection into the `consumables` index, swallowing any read error — a search hiccup
   * must never fail the domain write, and the row self-heals on its next write or a `reindex:all`. Called
   * fire-and-forget (`void`) by {@link createMovement} (whose tx returns the ledger row, not the
   * consumable) to refresh the cached `currentStock`; create/update/restore upsert their in-hand row
   * directly instead.
   */
  private async reindex(id: string): Promise<void> {
    try {
      const row = await this.prisma.consumable.findFirst({
        where: { id, deletedAt: null },
      });
      if (row) this.search?.upsert('consumables', projectConsumable(row));
    } catch {
      // Best-effort: a dropped re-index leaves the row stale until its next write or `reindex:all`.
    }
  }

  /**
   * Fire a `low_stock` bell nudge (ADR-0056 §3) when a movement transitioned the consumable from ABOVE
   * its `minStock` to AT/BELOW it — the DOWNWARD crossing only. A consumable that is already low and
   * merely flaps (out/in/out while still ≤ minStock) does NOT cross down, so it never re-fires (no
   * spam). Re-reads the post-commit stock and compares to the `before` snapshot:
   *   crossing ⇔ `before.currentStock > minStock` AND `after.currentStock <= minStock`.
   * The dedupe key carries a coarse DAILY bucket, so a genuine re-cross on a later day mints a fresh
   * nudge, while same-day re-crossings collapse to one. Best-effort: every failure is swallowed.
   */
  private async emitLowStock(
    consumableId: string,
    before: {
      currentStock: number;
      minStock: number | null;
      name: string;
    } | null,
  ): Promise<void> {
    try {
      // No threshold set, or the row was missing pre-commit → nothing to cross.
      if (!before || before.minStock == null) {
        return;
      }
      const min = before.minStock;
      // Already at/below before the movement → not a downward CROSSING (anti-flap guard).
      if (before.currentStock <= min) {
        return;
      }
      const after = await this.prisma.consumable.findFirst({
        where: { id: consumableId, deletedAt: null },
        select: { currentStock: true, name: true },
      });
      if (!after || after.currentStock > min) {
        return; // never crossed down (or the row vanished).
      }
      // Coarse daily bucket so a real re-cross on another day re-alerts, while same-day collapses to one.
      const dayBucket = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
      await this.notifications.emit({
        type: 'low_stock',
        dedupeKey: `low_stock:${consumableId}:${dayBucket}`,
        severity: 'warning',
        title: `${after.name} is low on stock`,
        summary: `${after.currentStock} left (minimum ${min}).`,
        entityType: 'consumable',
        entityId: consumableId,
        metadata: {
          name: after.name,
          currentStock: after.currentStock,
          minStock: min,
        },
      });
    } catch {
      // Best-effort: a failed nudge never affects the already-committed movement.
    }
  }

  /**
   * A consumable's movement ledger, newest first. Optional type + createdAt-range filters. Each row
   * carries its resolved delivery `target` (ADR-0098) — null for an untargeted movement — redacted per
   * the caller's read permissions on the target's domain (see {@link resolveTargets}).
   */
  async listMovements(
    consumableId: string,
    filters: MovementFilters = {},
    principal?: Principal,
  ) {
    await this.assertExists(consumableId);
    const { type, from, to } = filters;
    const rows = await this.prisma.consumableMovement.findMany({
      where: {
        consumableId,
        ...(type ? { type } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { id: 'desc' },
    });
    const targets = await this.resolveTargets(rows, principal);
    return rows.map((row, i) => ({ ...row, target: targets[i] }));
  }

  /**
   * The deliveries made to ONE user, asset or location (ADR-0098) — `GET /consumables/deliveries`. A page
   * (ADR-0030) of targeted OUT movements, newest first, each with the consumable it drew from, its
   * resolved target and its return state (`returnedQuantity`, `outstandingQuantity`).
   *
   *  - AUTHORIZATION: besides `consumable:read` (the route gate), the caller must hold the read
   *    permission of the target's domain — `user:read` to list a person's deliveries (a VIEWER lacks it:
   *    the same directory-relational rule as `GET /users/:id/assignments`, ADR-0046 P3), `asset:read`,
   *    `location:read`. Otherwise 403.
   *  - HISTORY NEVER VANISHES: deliveries of a since-soft-deleted consumable are included (the consumable
   *    carries its `deletedAt`), and the target itself may be offboarded/retired/archived — this read is
   *    exactly what the offboarding sheet / Return Act uses, so it never 404s on a soft-deleted target.
   *  - `outstandingOnly`: returnable deliveries whose returns do not yet cover the quantity. Filtered in
   *    SQL (a correlated SUM) so the page and its `total` stay authoritative.
   */
  async findDeliveries(
    filters: DeliveryFilters,
    page: PageQuery,
    principal?: Principal,
  ) {
    const target = targetOf(filters);
    if (!target) {
      // Unreachable through the controller (the query schema requires exactly one target).
      throw new BadRequestException(
        'Exactly one of targetUserId, targetAssetId or targetLocationId is required',
      );
    }
    const readable = await this.readableKinds(principal);
    if (!readable[target.kind]) {
      throw new ForbiddenException(
        `Listing deliveries to a ${target.kind} requires ${TARGET_READ_PERMISSION[target.kind]}`,
      );
    }

    const outstandingIds = filters.outstandingOnly
      ? await this.outstandingDeliveryIds(target)
      : undefined;
    const where: Prisma.ConsumableMovementWhereInput = {
      type: 'OUT',
      [target.key]: target.id,
      ...(outstandingIds ? { id: { in: outstandingIds } } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
    };
    const { take, skip } = offsetOf(page);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.consumableMovement.findMany({
        where,
        orderBy: { id: 'desc' },
        take,
        skip,
        // `Consumable` is not auto-filtered (ADR-0032) and a nested include is never filtered anyway: a
        // soft-deleted consumable's deliveries stay listed, flagged by its `deletedAt`.
        include: {
          consumable: {
            select: {
              id: true,
              name: true,
              sku: true,
              unit: true,
              deletedAt: true,
            },
          },
        },
      }),
      this.prisma.consumableMovement.count({ where }),
    ]);

    // Returned so far, per delivery on this page (one query).
    const returnable = rows.filter((row) => row.returnable);
    const returned = new Map<number, number>();
    if (returnable.length > 0) {
      const returns = await this.prisma.consumableMovement.findMany({
        where: { returnOfId: { in: returnable.map((row) => row.id) } },
        select: { returnOfId: true, quantity: true },
      });
      for (const r of returns) {
        if (r.returnOfId == null) continue;
        returned.set(
          r.returnOfId,
          (returned.get(r.returnOfId) ?? 0) + r.quantity,
        );
      }
    }
    const targets = await this.resolveTargets(rows, principal, readable);
    const items = rows.map((row, i) => {
      const returnedQuantity = row.returnable ? (returned.get(row.id) ?? 0) : 0;
      return {
        ...row,
        target: targets[i],
        returnedQuantity,
        outstandingQuantity: row.returnable
          ? Math.max(0, row.quantity - returnedQuantity)
          : 0,
      };
    });
    return pageOf(items, total, page);
  }

  /**
   * Ids of the OUTSTANDING returnable deliveries to one target: `returnable` OUTs whose linked returns sum
   * to less than their quantity. One correlated query; the target column is chosen from a fixed set (no
   * dynamic SQL) and every value is a bound parameter.
   */
  private async outstandingDeliveryIds(target: TargetRef): Promise<number[]> {
    let rows: { id: number }[];
    if (target.kind === 'user') {
      rows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT d."id" FROM "consumable_movements" d
        WHERE d."targetUserId" = ${target.id}::uuid
          AND d."type" = 'OUT'::"ConsumableMovementType" AND d."returnable" = true
          AND d."quantity" > COALESCE((SELECT SUM(r."quantity") FROM "consumable_movements" r
                                       WHERE r."returnOfId" = d."id"), 0)`;
    } else if (target.kind === 'asset') {
      rows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT d."id" FROM "consumable_movements" d
        WHERE d."targetAssetId" = ${target.id}
          AND d."type" = 'OUT'::"ConsumableMovementType" AND d."returnable" = true
          AND d."quantity" > COALESCE((SELECT SUM(r."quantity") FROM "consumable_movements" r
                                       WHERE r."returnOfId" = d."id"), 0)`;
    } else {
      rows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT d."id" FROM "consumable_movements" d
        WHERE d."targetLocationId" = ${target.id}
          AND d."type" = 'OUT'::"ConsumableMovementType" AND d."returnable" = true
          AND d."quantity" > COALESCE((SELECT SUM(r."quantity") FROM "consumable_movements" r
                                       WHERE r."returnOfId" = d."id"), 0)`;
    }
    return rows.map((row) => Number(row.id));
  }

  /**
   * Which target kinds the caller may see RESOLVED (ADR-0098): a kind is readable when the principal holds
   * its domain read permission (`user:read` / `asset:read` / `location:read`), for both principal kinds
   * (ADR-0048: a human via the RolePermission matrix, a service account via its direct grants). No
   * principal holds nothing (fail-closed).
   */
  private async readableKinds(principal?: Principal): Promise<ReadableKinds> {
    let held: ReadonlySet<Permission> = new Set<Permission>();
    if (principal?.kind === 'service') {
      held = principal.permissions;
    } else if (principal?.kind === 'human') {
      held = await this.permissions.resolve(principal.user.role);
    }
    return {
      user: held.has(TARGET_READ_PERMISSION.user),
      asset: held.has(TARGET_READ_PERMISSION.asset),
      location: held.has(TARGET_READ_PERMISSION.location),
    };
  }

  /**
   * Resolve each row's delivery target into the redaction-safe descriptor (ADR-0098), in at most one
   * query per kind (no N+1). Targets are looked up through the `includeSoftDeleted` escape hatch
   * (ADR-0032) so an offboarded user / retired asset / archived location is FOUND and flagged, never
   * dangling. A kind the caller cannot read (see {@link readableKinds}) is not queried at all: its
   * descriptor keeps the id and nulls the display fields. An untargeted row → null. A target row that is
   * genuinely gone (impossible under the Restrict FK) → null rather than a dangle.
   */
  private async resolveTargets(
    rows: TargetColumns[],
    principal?: Principal,
    known?: ReadableKinds,
  ): Promise<(ConsumableDeliveryTarget | null)[]> {
    const refs = rows.map((row) => targetOf(row));
    if (refs.every((ref) => ref === null)) {
      return refs.map(() => null);
    }
    const readable = known ?? (await this.readableKinds(principal));
    const idsOf = (kind: TargetKind) => [
      ...new Set(
        refs.filter((ref) => ref?.kind === kind).map((ref) => ref!.id),
      ),
    ];
    const userIds = readable.user ? idsOf('user') : [];
    const assetIds = readable.asset ? idsOf('asset') : [];
    const locationIds = readable.location ? idsOf('location') : [];
    const [users, assets, locations] = await Promise.all([
      userIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              deletedAt: true,
            },
            includeSoftDeleted: true,
          } as Prisma.UserFindManyArgs)
        : [],
      assetIds.length > 0
        ? this.prisma.asset.findMany({
            where: { id: { in: assetIds } },
            select: {
              id: true,
              assetTag: true,
              name: true,
              serial: true,
              deletedAt: true,
            },
            includeSoftDeleted: true,
          } as Prisma.AssetFindManyArgs)
        : [],
      locationIds.length > 0
        ? this.prisma.location.findMany({
            where: { id: { in: locationIds } },
            select: { id: true, name: true, deletedAt: true },
            includeSoftDeleted: true,
          } as Prisma.LocationFindManyArgs)
        : [],
    ]);
    const userById = new Map(
      (
        users as {
          id: string;
          firstName: string;
          lastName: string;
          deletedAt: Date | null;
        }[]
      ).map((u) => [u.id, u]),
    );
    const assetById = new Map(
      (
        assets as {
          id: string;
          assetTag: string | null;
          name: string | null;
          serial: string | null;
          deletedAt: Date | null;
        }[]
      ).map((a) => [a.id, a]),
    );
    const locationById = new Map(
      (locations as { id: string; name: string; deletedAt: Date | null }[]).map(
        (l) => [l.id, l],
      ),
    );

    return refs.map((ref): ConsumableDeliveryTarget | null => {
      if (!ref) return null;
      if (ref.kind === 'user') {
        if (!readable.user) {
          return {
            type: 'user',
            id: ref.id,
            displayName: null,
            isOffboarded: null,
          };
        }
        const u = userById.get(ref.id);
        return u
          ? {
              type: 'user',
              id: u.id,
              displayName: `${u.firstName} ${u.lastName}`.trim(),
              isOffboarded: u.deletedAt != null,
            }
          : null;
      }
      if (ref.kind === 'asset') {
        if (!readable.asset) {
          return { type: 'asset', id: ref.id, label: null, isDeleted: null };
        }
        const a = assetById.get(ref.id);
        return a
          ? {
              type: 'asset',
              id: a.id,
              label: a.assetTag ?? a.name ?? a.serial ?? a.id,
              isDeleted: a.deletedAt != null,
            }
          : null;
      }
      if (!readable.location) {
        return { type: 'location', id: ref.id, name: null, isDeleted: null };
      }
      const l = locationById.get(ref.id);
      return l
        ? {
            type: 'location',
            id: l.id,
            name: l.name,
            isDeleted: l.deletedAt != null,
          }
        : null;
    });
  }

  /**
   * Lightweight 404 guard for writes and nested endpoints (no relation loading). Live-scoped
   * (`deletedAt: null`) so `update`/`remove`/`listMovements` refuse a soft-deleted consumable —
   * `Consumable` is not auto-filtered by the ADR-0032 extension (SEC-050).
   */
  async assertExists(id: string): Promise<void> {
    const consumable = await this.prisma.consumable.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!consumable) {
      throw new NotFoundException(`Consumable ${id} not found`);
    }
  }
}
