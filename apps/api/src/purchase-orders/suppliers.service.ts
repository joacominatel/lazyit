import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateSupplier,
  PageQuery,
  SupplierMergeField,
  UpdateSupplier,
} from '@lazyit/shared';
import { SUPPLIER_MERGE_FIELDS, offsetOf, pageOf } from '@lazyit/shared';
import { Prisma, type Supplier } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { recordPurchaseOrderEvents } from './purchase-order-events';

/** Optional filters for listing suppliers. */
export interface SupplierFilters {
  /** Case-insensitive substring over name, tax ID and the contact names and emails (OR). */
  q?: string;
}

/** Server-side sort allowlist for `GET /suppliers` (ADR-0030). Default `name asc`. */
export const SUPPLIER_SORT_ALLOWLIST = {
  name: 'name',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

/** A merge's effect on the fields of the supplier that stays (see {@link planSupplierMerge}). */
export interface SupplierMergePlan {
  /** Empty on the kept supplier, set on the duplicate: filled from the duplicate. */
  fill: { field: SupplierMergeField; value: string }[];
  /** Set on both, differently: the kept supplier's value stays; the duplicate's is not copied. */
  kept: { field: SupplierMergeField; value: string; sourceValue: string }[];
}

/** A stored text value, or `null` when it is missing or blank. */
function present(value: string | null): string | null {
  return value !== null && value.trim() !== '' ? value : null;
}

/**
 * What merging `source` into `target` does to `target`'s fields (CEO decision, 2026-10-03): every field the
 * kept supplier leaves empty is filled from the duplicate, and nothing it holds is overwritten. Field by
 * field, the name never. Pure — the preview and the merge share it.
 */
export function planSupplierMerge(
  target: Pick<Supplier, SupplierMergeField>,
  source: Pick<Supplier, SupplierMergeField>,
): SupplierMergePlan {
  const plan: SupplierMergePlan = { fill: [], kept: [] };
  for (const field of SUPPLIER_MERGE_FIELDS) {
    const sourceValue = present(source[field]);
    if (sourceValue === null) continue;
    const value = present(target[field]);
    if (value === null) plan.fill.push({ field, value: sourceValue });
    else if (value !== sourceValue)
      plan.kept.push({ field, value, sourceValue });
  }
  return plan;
}

/**
 * Suppliers (ADR-0099 §2) — who the team buys from. Plain CRUD with soft delete and ADMIN restore. Nothing
 * is unique (CEO decision D-D): two suppliers with the same name or tax ID are both accepted; the web's
 * smart entry suggests the existing one instead. Soft-deleting a supplier leaves every purchase pointing
 * at it untouched (the purchase still shows it, flagged as archived).
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
  ) {}

  async findPage(filters: SupplierFilters, page: PageQuery) {
    const where: Prisma.SupplierWhereInput = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    // The ADR-0032 escape hatch is a custom arg the generated types do not carry (see ApplicationsService).
    const escapeHatch: Record<string, unknown> = includeSoftDeletedFor(
      page.deleted,
    )
      ? { includeSoftDeleted: true }
      : {};
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.SupplierOrderByWithRelationInput>(
        page,
        SUPPLIER_SORT_ALLOWLIST,
      ) ?? ({ name: 'asc' } satisfies Prisma.SupplierOrderByWithRelationInput);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.supplier.findMany({
        where,
        orderBy,
        take,
        skip,
        ...escapeHatch,
      }),
      this.prisma.supplier.count({ where, ...escapeHatch }),
    ]);
    return pageOf(items, total, page);
  }

  private buildWhere({ q }: SupplierFilters): Prisma.SupplierWhereInput {
    if (!q) return {};
    const contains = { contains: q, mode: 'insensitive' as const };
    return {
      OR: [
        { name: contains },
        { taxId: contains },
        { salesContactName: contains },
        { salesContactEmail: contains },
        { supportContactName: contains },
        { supportContactEmail: contains },
      ],
    };
  }

  /** A live supplier; 404 if missing or soft-deleted. */
  async findOne(id: string) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id } });
    if (!supplier) {
      throw new NotFoundException(`Supplier ${id} not found`);
    }
    return supplier;
  }

  create(data: CreateSupplier) {
    return this.prisma.supplier.create({ data });
  }

  async update(id: string, data: UpdateSupplier) {
    await this.findOne(id);
    return this.prisma.supplier.update({ where: { id }, data });
  }

  /** Soft delete (never hard-delete). The supplier's purchases keep pointing at it. */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.supplier.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Clear `deletedAt` (ADR-0041). 404 if it never existed; idempotent when already live. */
  async restore(id: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.SupplierFindFirstArgs);
    if (!supplier) {
      throw new NotFoundException(`Supplier ${id} not found`);
    }
    if (supplier.deletedAt === null) return supplier;
    return this.prisma.supplier.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  // ── Merge (#1496) ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * What merging `sourceId` into `targetId` would do, without writing: the purchases that would move (live
   * and archived), the empty fields that would be filled and the differing ones that stay. Refuses what the
   * merge refuses: the same supplier twice (400), a supplier that never existed (404), an archived one (409).
   */
  async mergePreview(targetId: string, sourceId: string) {
    assertDistinct(targetId, sourceId);
    const [target, source] = await Promise.all([
      this.findMergeable(targetId),
      this.findMergeable(sourceId),
    ]);
    const [live, archived] = await Promise.all([
      this.prisma.purchaseOrder.count({ where: { supplierId: sourceId } }),
      this.prisma.purchaseOrder.count({
        where: { supplierId: sourceId, deletedAt: { not: null } },
        includeSoftDeleted: true,
      } as Prisma.PurchaseOrderCountArgs),
    ]);
    return {
      target,
      source,
      purchases: { live, archived },
      ...planSupplierMerge(target, source),
    };
  }

  /**
   * Merge the duplicate `sourceId` into `targetId`, which stays (CEO decision, 2026-10-03; ADMIN through
   * `purchaseOrder:delete`). One transaction: every purchase of the duplicate — archived ones included —
   * moves to the kept supplier, the kept supplier's empty fields are filled from the duplicate (nothing is
   * overwritten), the duplicate is archived (never deleted), and each moved purchase records
   * `SUPPLIER_MERGED` with the actor.
   *
   * Lock order: both supplier rows `FOR NO KEY UPDATE` in id order, then the duplicate's purchases in id
   * order. A second merge of the same duplicate (or the reverse merge) waits on the supplier locks and then
   * sees an archived supplier (409). `NO KEY UPDATE` does not conflict with the `KEY SHARE` a purchase's
   * foreign-key check takes, and no purchase writer locks a supplier any other way, so purchase writes never
   * wait on a merge's supplier locks and the purchase-then-supplier order of a purchase update cannot cycle.
   * The purchases are re-read under their lock, so one moved to another supplier meanwhile stays where it is.
   */
  async merge(targetId: string, sourceId: string, principal?: Principal) {
    assertDistinct(targetId, sourceId);
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Supplier[]>`
        SELECT * FROM "suppliers" WHERE "id" IN (${targetId}, ${sourceId}) ORDER BY "id" FOR NO KEY UPDATE`;
      const target = assertMergeable(locked, targetId);
      const source = assertMergeable(locked, sourceId);
      const plan = planSupplierMerge(target, source);

      const moving = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "purchase_orders" WHERE "supplierId" = ${sourceId} ORDER BY "id" FOR NO KEY UPDATE`;
      const purchaseIds = moving.map((row) => row.id);
      if (purchaseIds.length > 0) {
        // `updateMany` is not read-filtered (ADR-0032): the archived purchases move too.
        await tx.purchaseOrder.updateMany({
          where: { id: { in: purchaseIds } },
          data: { supplierId: targetId },
        });
      }

      const filledFields = plan.fill.map((f) => f.field);
      const supplier =
        filledFields.length > 0
          ? await tx.supplier.update({
              where: { id: targetId },
              data: Object.fromEntries(
                plan.fill.map((f) => [f.field, f.value]),
              ),
            })
          : target;
      await tx.supplier.update({
        where: { id: sourceId },
        data: { deletedAt: new Date() },
      });

      await recordPurchaseOrderEvents(
        tx,
        purchaseIds,
        'SUPPLIER_MERGED',
        actor,
        {
          from: { id: source.id, name: source.name },
          to: { id: target.id, name: target.name },
          filledFields,
        },
      );
      return { supplier, movedPurchases: purchaseIds.length, filledFields };
    });
  }

  /** A supplier a merge can use: 404 if it never existed, 409 if it is archived. */
  private async findMergeable(id: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.SupplierFindFirstArgs);
    return assertMergeable(supplier ? [supplier] : [], id);
  }
}

/** Merging a supplier into itself is a mistake, not a no-op. */
function assertDistinct(targetId: string, sourceId: string) {
  if (targetId === sourceId) {
    throw new BadRequestException('A supplier cannot be merged into itself');
  }
}

/** The row for `id` among `rows`, live: 404 when absent, 409 when archived (a merged duplicate is archived). */
function assertMergeable(rows: readonly Supplier[], id: string): Supplier {
  const supplier = rows.find((row) => row.id === id);
  if (!supplier) {
    throw new NotFoundException(`Supplier ${id} not found`);
  }
  if (supplier.deletedAt !== null) {
    throw new ConflictException(
      `Supplier ${id} is archived; restore it before merging`,
    );
  }
  return supplier;
}
