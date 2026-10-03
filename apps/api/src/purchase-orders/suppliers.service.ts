import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { CreateSupplier, PageQuery, UpdateSupplier } from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseSearchSync } from '../search/purchase-search.sync';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';

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
    // Global search (#1499): re-index after each write. Optional, as in PurchaseOrdersService.
    @Optional() private readonly searchSync?: PurchaseSearchSync,
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

  async create(data: CreateSupplier) {
    const supplier = await this.prisma.supplier.create({ data });
    this.searchSync?.supplier(supplier.id);
    return supplier;
  }

  async update(id: string, data: UpdateSupplier) {
    await this.findOne(id);
    const supplier = await this.prisma.supplier.update({ where: { id }, data });
    this.searchSync?.supplier(id);
    return supplier;
  }

  /** Soft delete (never hard-delete). The supplier's purchases keep pointing at it. */
  async remove(id: string) {
    await this.findOne(id);
    const supplier = await this.prisma.supplier.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    this.searchSync?.supplier(id);
    return supplier;
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
    const restored = await this.prisma.supplier.update({
      where: { id },
      data: { deletedAt: null },
    });
    this.searchSync?.supplier(id);
    return restored;
  }
}
