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
        deletedAt: null,
        ...(categoryId ? { categoryId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** A single non-deleted model by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const model = await this.prisma.assetModel.findFirst({
      where: { id, deletedAt: null },
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
}
