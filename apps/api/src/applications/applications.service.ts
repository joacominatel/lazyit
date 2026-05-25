import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateApplication, UpdateApplication } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ApplicationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All non-deleted applications, alphabetically by name. */
  findAll() {
    return this.prisma.application.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  /** A single non-deleted application by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const application = await this.prisma.application.findFirst({
      where: { id, deletedAt: null },
    });
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    return application;
  }

  create(data: CreateApplication) {
    const { metadata, ...rest } = data;
    return this.prisma.application.create({
      data: {
        ...rest,
        ...(metadata !== undefined
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async update(id: string, data: UpdateApplication) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const { metadata, ...rest } = data;
    return this.prisma.application.update({
      where: { id },
      data: {
        ...rest,
        ...(metadata !== undefined
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  /**
   * Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). Existing
   * grants are preserved and keep pointing here; the FK `Restrict` is only a hard-delete safety
   * net — soft delete bypasses it (ADR-0023).
   */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.application.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
