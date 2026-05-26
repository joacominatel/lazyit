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
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';

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
   * Record a stock movement and adjust the cached `currentStock` atomically (ADR-0034). The actor
   * comes from the X-User-Id shim. IN adds, OUT subtracts (409 if it would go negative — nothing is
   * persisted), ADJUSTMENT sets `currentStock` to the absolute `quantity`. Returns the ledger row.
   */
  async createMovement(
    consumableId: string,
    data: CreateConsumableMovement,
    actorId?: string,
  ) {
    const performedById = await this.actor.resolve(actorId);
    const { type, quantity, reason, notes } = data;

    return this.prisma.$transaction(async (tx) => {
      const consumable = await tx.consumable.findFirst({
        where: { id: consumableId },
        select: { id: true, currentStock: true },
      });
      if (!consumable) {
        throw new NotFoundException(`Consumable ${consumableId} not found`);
      }

      let nextStock: number;
      if (type === 'IN') {
        nextStock = consumable.currentStock + quantity;
      } else if (type === 'OUT') {
        nextStock = consumable.currentStock - quantity;
        if (nextStock < 0) {
          throw new ConflictException(
            `Insufficient stock: have ${consumable.currentStock}, cannot remove ${quantity}`,
          );
        }
      } else {
        // ADJUSTMENT: an absolute recount.
        nextStock = quantity;
      }

      await tx.consumable.update({
        where: { id: consumableId },
        data: { currentStock: nextStock },
      });

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
