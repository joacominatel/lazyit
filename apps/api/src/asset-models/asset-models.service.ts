import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateAssetModel, UpdateAssetModel } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AssetModelsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Non-deleted models, newest first, optionally filtered by category. */
  findAll(categoryId?: string) {
    return this.prisma.assetModel.findMany({
      where: {
        ...(categoryId ? { categoryId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** A single non-deleted model by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const model = await this.prisma.assetModel.findFirst({
      where: { id },
    });
    if (!model) {
      throw new NotFoundException(`AssetModel ${id} not found`);
    }
    return model;
  }

  /** Create. An invalid categoryId hits the FK and is mapped to 400 by PrismaExceptionFilter. */
  create(data: CreateAssetModel) {
    const { specs, ...rest } = data;
    return this.prisma.assetModel.create({
      // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
      data: {
        ...rest,
        ...(specs !== undefined ? { specs: specs as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async update(id: string, data: UpdateAssetModel) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const { specs, ...rest } = data;
    return this.prisma.assetModel.update({
      where: { id },
      data: {
        ...rest,
        ...(specs !== undefined ? { specs: specs as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.assetModel.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Restore a soft-deleted model: clear `deletedAt` (ADR-0041). Found via the `includeSoftDeleted`
   * escape hatch (the read filter would hide it). 404 if it never existed; idempotent if already
   * live. The partial unique index frees `sku` on delete, so a restore can 409 if another live model
   * took the sku in the meantime (mapped by the global PrismaExceptionFilter).
   */
  async restore(id: string) {
    const model = await this.prisma.assetModel.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.AssetModelFindFirstArgs);
    if (!model) {
      throw new NotFoundException(`AssetModel ${id} not found`);
    }
    if (model.deletedAt === null) {
      return model; // already live — idempotent
    }
    return this.prisma.assetModel.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
