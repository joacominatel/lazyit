import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateAssetCategory, UpdateAssetCategory } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AssetCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** All categories that have not been soft-deleted, alphabetically (it's a reference list). */
  findAll() {
    return this.prisma.assetCategory.findMany({
      orderBy: { name: 'asc' },
    });
  }

  /** A single non-deleted category by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const category = await this.prisma.assetCategory.findFirst({
      where: { id },
    });
    if (!category) {
      throw new NotFoundException(`AssetCategory ${id} not found`);
    }
    return category;
  }

  create(data: CreateAssetCategory) {
    // specsSchema is the advisory declarative dictionary (ADR-0007 amendment, #851): a jsonb field.
    // Omitted from the write when absent so an unset category stores NULL (no governance) —
    // byte-for-byte the pre-#851 create path for callers that don't use it.
    const { specsSchema, ...rest } = data;
    return this.prisma.assetCategory.create({
      data: { ...rest, ...(specsSchema !== undefined ? { specsSchema } : {}) },
    });
  }

  async update(id: string, data: UpdateAssetCategory) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    // A caller replaces the whole dictionary; `specsSchema: []` clears it (no governance).
    const { specsSchema, ...rest } = data;
    return this.prisma.assetCategory.update({
      where: { id },
      data: { ...rest, ...(specsSchema !== undefined ? { specsSchema } : {}) },
    });
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.assetCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Restore a soft-deleted category: clear `deletedAt` (ADR-0041). Found via the `includeSoftDeleted`
   * escape hatch (the read filter would hide it). 404 if it never existed; idempotent if already
   * live. The partial unique index frees `name` on delete, so a restore can 409 if another live
   * category took the name in the meantime (mapped by the global PrismaExceptionFilter).
   */
  async restore(id: string) {
    const category = await this.prisma.assetCategory.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.AssetCategoryFindFirstArgs);
    if (!category) {
      throw new NotFoundException(`AssetCategory ${id} not found`);
    }
    if (category.deletedAt === null) {
      return category; // already live — idempotent
    }
    return this.prisma.assetCategory.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
