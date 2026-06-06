import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateApplication,
  PageQuery,
  UpdateApplication,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectApplication } from '../search/search.documents';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';

/** Optional filters for listing applications. */
export interface ApplicationFilters {
  /** Case-insensitive substring over name / vendor / url / description (OR). */
  q?: string;
}

/**
 * Server-side sort allowlist for `GET /applications` (ADR-0030 amendment). Maps each PUBLIC `?sort=`
 * key to the Prisma column. Unknown key → 400. With no `sort`, the list keeps its default `name asc`.
 */
export const APPLICATION_SORT_ALLOWLIST = {
  name: 'name',
  vendor: 'vendor',
  isCritical: 'isCritical',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  /**
   * A single page of applications (default `name asc`). Server-side `q` search (over
   * name/vendor/url/description) and an allowlisted sort make the list authoritative — migrated off
   * the raw-array contract that filtered client-side and silently truncated past the window
   * (ADR-0030). The `deleted` slice (`active` default | `only`) scopes the page to live or
   * soft-deleted rows; `only` carries the ADR-0032 `includeSoftDeleted` escape hatch so the read
   * filter doesn't re-hide them (ADMIN-gated at the controller). Runs `findMany(take/skip)` + `count`
   * over the same `where` in one `$transaction`.
   */
  async findPage(filters: ApplicationFilters, page: PageQuery) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.ApplicationOrderByWithRelationInput>(
        page,
        APPLICATION_SORT_ALLOWLIST,
      ) ??
      ({ name: 'asc' } satisfies Prisma.ApplicationOrderByWithRelationInput);
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object rather than fighting the type.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.application.findMany({
        where,
        orderBy,
        take,
        skip,
        ...escapeHatch,
      }),
      this.prisma.application.count({ where, ...escapeHatch }),
    ]);
    return pageOf(items, total, page);
  }

  /** The shared `where` for the application list — used identically by findPage and its count. */
  private buildWhere({ q }: ApplicationFilters): Prisma.ApplicationWhereInput {
    return q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { vendor: { contains: q, mode: 'insensitive' } },
            { url: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};
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
    if (data.categoryId) await this.assertCategoryUsable(data.categoryId);
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
    if (data.categoryId) await this.assertCategoryUsable(data.categoryId);
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

  /**
   * Restore a soft-deleted application: clear `deletedAt` (ADR-0041). Found via the
   * `includeSoftDeleted` escape hatch (the read filter would hide it). 404 if it never existed;
   * idempotent if already live. Re-indexes for search on success.
   */
  async restore(id: string) {
    const application = await this.prisma.application.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.ApplicationFindFirstArgs);
    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    if (application.deletedAt === null) {
      return application; // already live — idempotent
    }
    const restored = await this.prisma.application.update({
      where: { id },
      data: { deletedAt: null },
    });
    // Re-index the restored application (ADR-0035).
    this.search.upsert('applications', projectApplication(restored));
    return restored;
  }

  /**
   * 400 if categoryId doesn't reference a LIVE (non-soft-deleted) category (SEC-052). The FK alone is
   * satisfied by a soft-deleted ApplicationCategory row, so guard it explicitly — the soft-delete
   * read filter returns null for an archived category. Mirrors the articles `assertCategoryUsable`.
   */
  private async assertCategoryUsable(categoryId: string): Promise<void> {
    const category = await this.prisma.applicationCategory.findFirst({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new BadRequestException(
        `categoryId ${categoryId} does not reference a live category`,
      );
    }
  }
}
