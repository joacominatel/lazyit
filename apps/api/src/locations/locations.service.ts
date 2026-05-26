import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateLocation, UpdateLocation } from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

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

  create(data: CreateLocation) {
    return this.prisma.location.create({ data });
  }

  async update(id: string, data: UpdateLocation) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    return this.prisma.location.update({ where: { id }, data });
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.location.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
