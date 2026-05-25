import { Injectable, NotFoundException } from '@nestjs/common';
import type { AssetStatus, CreateAsset, UpdateAsset } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Optional filters for listing assets. `categoryId` filters by the asset's model's category. */
export interface AssetFilters {
  categoryId?: string;
  locationId?: string;
  status?: AssetStatus;
}

@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Non-deleted assets, newest first, optionally filtered by category / location / status. */
  findAll(filters: AssetFilters = {}) {
    const { categoryId, locationId, status } = filters;
    return this.prisma.asset.findMany({
      where: {
        deletedAt: null,
        ...(locationId ? { locationId } : {}),
        ...(status ? { status } : {}),
        // Category lives on the model, not the asset: match assets whose model is in it.
        ...(categoryId ? { model: { categoryId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** A single non-deleted asset by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id, deletedAt: null },
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    return asset;
  }

  /** Create. Invalid modelId/locationId hit the FK and are mapped to 400 by PrismaExceptionFilter. */
  create(data: CreateAsset) {
    const { specs, ...rest } = data;
    return this.prisma.asset.create({
      // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
      data: {
        ...rest,
        ...(specs !== undefined ? { specs: specs as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async update(id: string, data: UpdateAsset) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const { specs, ...rest } = data;
    return this.prisma.asset.update({
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
    return this.prisma.asset.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
