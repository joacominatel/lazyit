import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateApplication, UpdateApplication } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectApplication } from '../search/search.documents';

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  /** All non-deleted applications, alphabetically by name. */
  findAll() {
    return this.prisma.application.findMany({
      orderBy: { name: 'asc' },
    });
  }

  /** A single non-deleted application by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const application = await this.prisma.application.findFirst({
      where: { id },
    });
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    return application;
  }

  async create(data: CreateApplication) {
    const { metadata, ...rest } = data;
    const application = await this.prisma.application.create({
      data: {
        ...rest,
        ...(metadata !== undefined
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('applications', projectApplication(application));
    return application;
  }

  async update(id: string, data: UpdateApplication) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const { metadata, ...rest } = data;
    const application = await this.prisma.application.update({
      where: { id },
      data: {
        ...rest,
        ...(metadata !== undefined
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    this.search.upsert('applications', projectApplication(application));
    return application;
  }

  /**
   * Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). Existing
   * grants are preserved and keep pointing here; the FK `Restrict` is only a hard-delete safety
   * net — soft delete bypasses it (ADR-0023).
   */
  async remove(id: string) {
    await this.findOne(id);
    const application = await this.prisma.application.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Drop from the index so soft-deleted applications never surface in search (ADR-0035).
    this.search.remove('applications', id);
    return application;
  }
}
