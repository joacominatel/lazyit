import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  Permission,
  Suggestion,
  SuggestionField,
  SuggestionQuery,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';

/** One distinct value of one source column, with its live-row count and latest update. */
interface SourceRow {
  value: string;
  count: number;
  lastUsedAt: Date;
}

/** A source of suggestions: a column of one table, guarded by the permission that guards the table. */
interface Source {
  permission: Permission;
  read: (contains: string | undefined, take: number) => Promise<SourceRow[]>;
}

/**
 * Distinct values read per source before merging. A field's vocabulary (companies, manufacturers,
 * currency labels) is small on a 5–20 person estate; this bounds the work when it is not. A merged value
 * whose per-source counts all fall past the cap may be ranked slightly low — never wrong in kind.
 */
const SOURCE_CAP = 500;

/**
 * Smart-entry suggestions (ADR-0099 §7, CEO input 1): the values already typed in lazyit for a free-text
 * field, with how often and how recently they were used, so the web ranks most-used, last-used and closest
 * matches and hints at near-duplicates. Values are returned exactly as stored and grouped by exact text;
 * the client normalizes. Every read counts LIVE rows only (the soft-delete read filter, ADR-0032).
 *
 * Authorization is per SOURCE, not per route: a field may merge columns guarded by different permissions
 * (a currency label lives on purchases and on assets). The caller sees only the sources it may read, and a
 * field with no readable source is a 403 — a suggestion never reveals more than the caller could list.
 */
@Injectable()
export class SuggestionsService {
  /** The whitelist: each field and its sources. A field missing here cannot be asked for (400 upstream). */
  private readonly fields: Record<SuggestionField, Source[]>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
  ) {
    const insensitive = (q: string | undefined) =>
      q ? { contains: q, mode: 'insensitive' as const } : undefined;
    this.fields = {
      supplierName: [
        {
          permission: 'purchaseOrder:read',
          read: async (q, take) =>
            (
              await this.prisma.supplier.groupBy({
                by: ['name'],
                where: q ? { name: insensitive(q) } : {},
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { name: 'desc' } },
                take,
              })
            ).map((g) => row(g.name, g._count._all, g._max.updatedAt)),
        },
      ],
      currency: [
        {
          permission: 'purchaseOrder:read',
          read: async (q, take) =>
            (
              await this.prisma.purchaseOrder.groupBy({
                by: ['currency'],
                where: { currency: { not: null, ...insensitive(q) } },
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { currency: 'desc' } },
                take,
              })
            ).map((g) => row(g.currency, g._count._all, g._max.updatedAt)),
        },
        {
          permission: 'asset:read',
          read: async (q, take) =>
            (
              await this.prisma.asset.groupBy({
                by: ['purchaseCurrency'],
                where: { purchaseCurrency: { not: null, ...insensitive(q) } },
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { purchaseCurrency: 'desc' } },
                take,
              })
            ).map((g) =>
              row(g.purchaseCurrency, g._count._all, g._max.updatedAt),
            ),
        },
      ],
      company: [
        {
          permission: 'asset:read',
          read: async (q, take) =>
            (
              await this.prisma.asset.groupBy({
                by: ['company'],
                where: { company: { not: null, ...insensitive(q) } },
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { company: 'desc' } },
                take,
              })
            ).map((g) => row(g.company, g._count._all, g._max.updatedAt)),
        },
        {
          permission: 'purchaseOrder:read',
          read: async (q, take) =>
            (
              await this.prisma.purchaseOrder.groupBy({
                by: ['company'],
                where: { company: { not: null, ...insensitive(q) } },
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { company: 'desc' } },
                take,
              })
            ).map((g) => row(g.company, g._count._all, g._max.updatedAt)),
        },
      ],
      manufacturer: [
        {
          permission: 'assetModel:read',
          read: async (q, take) =>
            (
              await this.prisma.assetModel.groupBy({
                by: ['manufacturer'],
                where: q ? { manufacturer: insensitive(q) } : {},
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { manufacturer: 'desc' } },
                take,
              })
            ).map((g) => row(g.manufacturer, g._count._all, g._max.updatedAt)),
        },
        {
          permission: 'purchaseOrder:read',
          read: async (q, take) =>
            (
              await this.prisma.purchaseOrderLine.groupBy({
                by: ['manufacturerText'],
                // A line of an archived purchase is archived with it (relation filter, ADR-0032).
                where: {
                  manufacturerText: { not: null, ...insensitive(q) },
                  purchaseOrder: { deletedAt: null },
                },
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { manufacturerText: 'desc' } },
                take,
              })
            ).map((g) =>
              row(g.manufacturerText, g._count._all, g._max.updatedAt),
            ),
        },
      ],
      lineModel: [
        {
          permission: 'purchaseOrder:read',
          read: async (q, take) =>
            (
              await this.prisma.purchaseOrderLine.groupBy({
                by: ['modelText'],
                where: {
                  modelText: { not: null, ...insensitive(q) },
                  purchaseOrder: { deletedAt: null },
                },
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { modelText: 'desc' } },
                take,
              })
            ).map((g) => row(g.modelText, g._count._all, g._max.updatedAt)),
        },
      ],
      vendor: [
        {
          permission: 'application:read',
          read: async (q, take) =>
            (
              await this.prisma.application.groupBy({
                by: ['vendor'],
                where: { vendor: { not: null, ...insensitive(q) } },
                _count: { _all: true },
                _max: { updatedAt: true },
                orderBy: { _count: { vendor: 'desc' } },
                take,
              })
            ).map((g) => row(g.vendor, g._count._all, g._max.updatedAt)),
        },
      ],
    };
  }

  /**
   * The ranked suggestions for `field`: the readable sources merged by exact value (counts summed, latest
   * use kept), ordered by count desc, then last use desc, then value. 403 when no source is readable.
   */
  async suggest(
    field: SuggestionField,
    query: SuggestionQuery,
    principal?: Principal,
  ): Promise<Suggestion[]> {
    const held = await this.heldPermissions(principal);
    const readable = this.fields[field].filter((source) =>
      held.has(source.permission),
    );
    if (readable.length === 0) {
      throw new ForbiddenException(
        'You do not have permission to read suggestions for this field',
      );
    }
    const q = query.q ? query.q : undefined;
    const results = await Promise.all(
      readable.map((source) => source.read(q, SOURCE_CAP)),
    );
    const merged = new Map<string, SourceRow>();
    for (const rows of results) {
      for (const r of rows) {
        // Blank values carry no suggestion (a legacy row may hold "" or whitespace).
        if (r.value.trim() === '') continue;
        const existing = merged.get(r.value);
        if (!existing) {
          merged.set(r.value, { ...r });
        } else {
          existing.count += r.count;
          if (r.lastUsedAt > existing.lastUsedAt) {
            existing.lastUsedAt = r.lastUsedAt;
          }
        }
      }
    }
    return [...merged.values()]
      .sort(
        (a, b) =>
          b.count - a.count ||
          b.lastUsedAt.getTime() - a.lastUsedAt.getTime() ||
          a.value.localeCompare(b.value),
      )
      .slice(0, query.limit)
      .map((r) => ({
        value: r.value,
        count: r.count,
        lastUsedAt: r.lastUsedAt.toISOString(),
      }));
  }

  /** The caller's permission set: a human via the role matrix, a service account via its grants. */
  private async heldPermissions(
    principal?: Principal,
  ): Promise<ReadonlySet<Permission>> {
    if (principal?.kind === 'service') return principal.permissions;
    if (principal?.kind === 'human') {
      return this.permissions.resolve(principal.user.role);
    }
    return new Set<Permission>();
  }
}

/** A grouped row as a {@link SourceRow}. A group always has rows, so `updatedAt` is set. */
function row(
  value: string | null,
  count: number,
  lastUsedAt: Date | null,
): SourceRow {
  return { value: value ?? '', count, lastUsedAt: lastUsedAt ?? new Date(0) };
}
