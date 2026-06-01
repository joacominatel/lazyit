import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateLocation, UpdateLocation } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectLocation } from '../search/search.documents';

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  /** All locations that have not been soft-deleted. */
  findAll() {
    return this.prisma.location.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /** A single non-deleted location by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const location = await this.prisma.location.findFirst({
      where: { id },
    });
    if (!location) {
      throw new NotFoundException(`Location ${id} not found`);
    }
    return location;
  }

  async create(data: CreateLocation) {
    const location = await this.prisma.location.create({ data });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('locations', projectLocation(location));
    return location;
  }

  async update(id: string, data: UpdateLocation) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const location = await this.prisma.location.update({ where: { id }, data });
    this.search.upsert('locations', projectLocation(location));
    return location;
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.findOne(id);
    const location = await this.prisma.location.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Drop from the index so soft-deleted locations never surface in search (ADR-0035).
    this.search.remove('locations', id);
    return location;
  }

  /**
   * Restore a soft-deleted location: clear `deletedAt` (ADR-0041). Finds the row via the
   * `includeSoftDeleted` escape hatch (the soft-delete read filter would hide it otherwise), 404s if
   * it never existed, and is idempotent if the row is already live. Re-indexes for search on success.
   * The partial unique index frees the name on delete, so a restore can collide with a row created in
   * the meantime — Prisma surfaces that as a 409 via the global PrismaExceptionFilter.
   */
  async restore(id: string) {
    const location = await this.prisma.location.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.LocationFindFirstArgs);
    if (!location) {
      throw new NotFoundException(`Location ${id} not found`);
    }
    if (location.deletedAt === null) {
      return location; // already live — idempotent
    }
    const restored = await this.prisma.location.update({
      where: { id },
      data: { deletedAt: null },
    });
    // Re-index the restored location (ADR-0035).
    this.search.upsert('locations', projectLocation(restored));
    return restored;
  }
}
