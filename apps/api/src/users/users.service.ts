import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateUser, UpdateUser } from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** All users that have not been soft-deleted. */
  findAll() {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** A single non-deleted user by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  create(data: CreateUser) {
    return this.prisma.user.create({ data });
  }

  async update(id: string, data: UpdateUser) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    return this.prisma.user.update({ where: { id }, data });
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
