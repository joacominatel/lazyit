import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  CreateConsumable,
  CreateConsumableMovement,
  PageQuery,
  UpdateConsumable,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
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

@Injectable()
export class ConsumablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly notifications: NotificationsService,
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
    const { type, quantity, reason, notes } = data;

    // BEFORE-snapshot (live row only) for the low-stock crossing check (ADR-0056 §3). A light read
    // outside the tx; null when the row is missing/soft-deleted (the tx below 404s those). The crossing
    // is computed from this `before` stock vs the `after` re-read once the tx commits.
    const before = await this.prisma.consumable.findFirst({
      where: { id: consumableId, deletedAt: null },
      select: { currentStock: true, minStock: true, name: true },
    });

    const movement = await this.prisma.$transaction(async (tx) => {
      if (type === 'IN') {
        // Read only to enforce the int4 ceiling and a clean 404; the write itself is atomic. Scoped
        // to the LIVE row (`deletedAt: null`) so a soft-deleted consumable reads as null → 404 and is
        // never incremented — `Consumable` is not auto-filtered by the ADR-0032 extension (SEC-050).
        const consumable = await tx.consumable.findFirst({
          where: { id: consumableId, deletedAt: null },
          select: { currentStock: true },
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

      return tx.consumableMovement.create({
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
        },
      });
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

  /** A consumable's movement ledger, newest first. Optional type + createdAt-range filters. */
  async listMovements(consumableId: string, filters: MovementFilters = {}) {
    await this.assertExists(consumableId);
    const { type, from, to } = filters;
    return this.prisma.consumableMovement.findMany({
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
