import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateConsumable,
  CreateConsumableMovement,
  UpdateConsumable,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';

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
}

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
  ) {}

  /**
   * Non-deleted consumables, ordered by name. With `lowStock`, restricts to items that declare a
   * `minStock` and whose `currentStock` is at or below it — a column-to-column comparison via a
   * Prisma field reference (`prisma.consumable.fields.minStock`).
   */
  findAll(filters: ConsumableFilters = {}) {
    return this.prisma.consumable.findMany({
      where: filters.lowStock
        ? {
            minStock: { not: null },
            currentStock: { lte: this.prisma.consumable.fields.minStock },
          }
        : {},
      orderBy: { name: 'asc' },
    });
  }

  /** A single non-deleted consumable by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const consumable = await this.prisma.consumable.findFirst({
      where: { id },
    });
    if (!consumable) {
      throw new NotFoundException(`Consumable ${id} not found`);
    }
    return consumable;
  }

  /**
   * Create. `currentStock` is never set here — it starts at the schema default (0) and only moves
   * through movements (ADR-0034). Invalid categoryId hits the FK and is mapped to 400.
   */
  create(data: CreateConsumable) {
    return this.prisma.consumable.create({ data });
  }

  /** Partial update. `currentStock` is not updatable here. 404 if missing or already soft-deleted. */
  async update(id: string, data: UpdateConsumable) {
    await this.assertExists(id);
    return this.prisma.consumable.update({ where: { id }, data });
  }

  /** Soft delete: set deletedAt (never hard-delete; movements keep the FK alive). */
  async remove(id: string) {
    await this.assertExists(id);
    return this.prisma.consumable.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
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
    return this.prisma.consumable.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  /**
   * Record a stock movement and adjust the cached `currentStock` atomically (ADR-0034), in the same
   * transaction as the ledger insert so the cache and the ledger never diverge. The actor comes from
   * the authenticated User.
   *
   * The cache write is done with **atomic, conditional SQL** rather than a JS read-modify-write, so
   * two concurrent movements can't lost-update each other under Read Committed:
   *   - IN          → `increment` (a single `UPDATE ... SET currentStock = currentStock + qty`).
   *   - OUT         → a **guarded** `updateMany` that decrements only while `currentStock >= qty`
   *                   (and the row is live); if it matches 0 rows the stock is insufficient (or the
   *                   row vanished) → **409**, and the whole transaction rolls back.
   *   - ADJUSTMENT  → set `currentStock` to the absolute `quantity` (a physical recount).
   *
   * Overflow guard: an IN whose result would exceed int4 (`> INT4_MAX`) is rejected as a **409**
   * before any write, so the cache can never silently wrap or hit a P2020 mid-transaction. Returns
   * the ledger row.
   */
  async createMovement(
    consumableId: string,
    data: CreateConsumableMovement,
    user?: User,
  ) {
    const performedById = this.actor.resolve(user);
    const { type, quantity, reason, notes } = data;

    return this.prisma.$transaction(async (tx) => {
      if (type === 'IN') {
        // Read only to enforce the int4 ceiling and a clean 404; the write itself is atomic.
        const consumable = await tx.consumable.findFirst({
          where: { id: consumableId },
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
          where: { id: consumableId, deletedAt: null, currentStock: { gte: quantity } },
          data: { currentStock: { decrement: quantity } },
        });
        if (result.count === 0) {
          // Distinguish "no such (live) consumable" (404) from "not enough stock" (409).
          const consumable = await tx.consumable.findFirst({
            where: { id: consumableId },
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
        // overflow is possible here. `update` 404s (P2025) if the row is missing/soft-deleted.
        await tx.consumable.update({
          where: { id: consumableId },
          data: { currentStock: quantity },
        });
      }

      return tx.consumableMovement.create({
        data: {
          consumableId,
          type,
          quantity,
          ...(reason !== undefined ? { reason } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(performedById != null ? { performedById } : {}),
        },
      });
    });
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

  /** Lightweight 404 guard for writes and nested endpoints (no relation loading). */
  async assertExists(id: string): Promise<void> {
    const consumable = await this.prisma.consumable.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!consumable) {
      throw new NotFoundException(`Consumable ${id} not found`);
    }
  }
}
