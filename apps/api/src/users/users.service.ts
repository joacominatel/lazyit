import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateUser, UpdateUser } from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectUser } from '../search/search.documents';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  /** All users that have not been soft-deleted. */
  findAll() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /** A single non-deleted user by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id },
    });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async create(data: CreateUser) {
    const user = await this.prisma.user.create({ data });
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('users', projectUser(user));
    return user;
  }

  async update(id: string, data: UpdateUser) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const user = await this.prisma.user.update({ where: { id }, data });
    this.search.upsert('users', projectUser(user));
    return user;
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.findOne(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Drop from the index so soft-deleted users never surface in search (ADR-0035).
    this.search.remove('users', id);
    return user;
  }
}
