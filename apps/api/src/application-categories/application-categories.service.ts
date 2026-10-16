import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DELETE_IMPACT_SAMPLE_LIMIT,
  type ApplicationCategoryDeleteImpact,
  type CreateApplicationCategory,
  type DeleteResolution,
  type UpdateApplicationCategory,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import { deleteResolutionRequired } from '../common/delete-resolution';

/**
 * Live applications only (#1540): `usageCount` counts what an operator sees in the catalog. A relation
 * `_count` is not rewritten by the ADR-0032 read filter, so the `deletedAt: null` is explicit.
 */
const LIVE_APPLICATION_COUNT = {
  _count: { select: { applications: { where: { deletedAt: null } } } },
} as const satisfies Prisma.ApplicationCategoryInclude;

type CategoryWithCount = Prisma.ApplicationCategoryGetPayload<{
  include: typeof LIVE_APPLICATION_COUNT;
}>;

function withUsageCount(row: CategoryWithCount) {
  const { _count, ...category } = row;
  return { ...category, usageCount: _count.applications };
}

@Injectable()
export class ApplicationCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * All non-deleted categories, ordered by `order` (nulls last) then name, each with the computed
   * `usageCount` of live applications filed under it (#1540) — one query, the count is a relation
   * aggregate, not a per-row lookup. Only this list read carries it; single reads and writes do not.
   */
  async findAll() {
    const rows = await this.prisma.applicationCategory.findMany({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      include: LIVE_APPLICATION_COUNT,
    });
    return rows.map(withUsageCount);
  }

  /** A single non-deleted category by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const category = await this.prisma.applicationCategory.findFirst({
      where: { id },
    });
    if (!category) {
      throw new NotFoundException(`ApplicationCategory ${id} not found`);
    }
    return category;
  }

  create(data: CreateApplicationCategory) {
    return this.prisma.applicationCategory.create({ data });
  }

  async update(id: string, data: UpdateApplicationCategory) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    return this.prisma.applicationCategory.update({ where: { id }, data });
  }

  /** The live applications a delete would detach or move; the list only when the caller may read applications. */
  async deleteImpact(
    id: string,
    principal?: Principal,
  ): Promise<ApplicationCategoryDeleteImpact> {
    await this.findOne(id);
    const where = { categoryId: id, deletedAt: null };
    const [total, items] = await Promise.all([
      this.prisma.application.count({ where }),
      (await this.permissions.principalHas(principal, 'application:read'))
        ? this.prisma.application.findMany({
            where,
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
            take: DELETE_IMPACT_SAMPLE_LIMIT,
          })
        : null,
    ]);
    return { applications: { total, items } };
  }

  /** Soft delete; live applications still filed here need the one `resolution`, applied in the same transaction. */
  async remove(id: string, resolution?: DeleteResolution) {
    return this.prisma.$transaction(async (tx) => {
      const targetId =
        resolution?.strategy === 'move' ? resolution.targetId : undefined;
      // Both rows in id order, so two deletes moving into each other cannot deadlock.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "application_categories"
         WHERE "id" IN (${Prisma.join(targetId ? [id, targetId] : [id])})
           AND "deletedAt" IS NULL
         ORDER BY "id" FOR UPDATE`;
      if (!locked.some((row) => row.id === id)) {
        throw new NotFoundException(`ApplicationCategory ${id} not found`);
      }
      const affected = await tx.application.findMany({
        where: { categoryId: id, deletedAt: null },
        select: { id: true },
      });
      if (affected.length > 0) {
        if (!resolution) {
          throw deleteResolutionRequired(`ApplicationCategory ${id}`, {
            applications: affected.length,
          });
        }
        if (targetId === id) {
          throw new BadRequestException(
            'Choose another category to move to, not the one being deleted.',
          );
        }
        if (targetId && !locked.some((row) => row.id === targetId)) {
          throw new BadRequestException(
            `Target category ${targetId} not found (missing or archived).`,
          );
        }
        await tx.application.updateMany({
          where: { id: { in: affected.map((row) => row.id) }, categoryId: id },
          data: { categoryId: targetId ?? null },
        });
      }
      return tx.applicationCategory.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });
  }

  /**
   * Restore a soft-deleted category: clear `deletedAt` (ADR-0041). Found via the `includeSoftDeleted`
   * escape hatch (the read filter would hide it). 404 if it never existed; idempotent if already
   * live. The partial unique index frees `name` on delete, so a restore can 409 if another live
   * category took the name in the meantime (mapped by the global PrismaExceptionFilter).
   */
  async restore(id: string) {
    const category = await this.prisma.applicationCategory.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.ApplicationCategoryFindFirstArgs);
    if (!category) {
      throw new NotFoundException(`ApplicationCategory ${id} not found`);
    }
    if (category.deletedAt === null) {
      return category; // already live — idempotent
    }
    return this.prisma.applicationCategory.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
