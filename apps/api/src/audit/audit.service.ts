import { Injectable } from '@nestjs/common';
import type {
  AuditLogFilterOptions,
  AuditLogFilters,
  AuditLogItem,
  AuditLogQuery,
  AuditLogSource,
  Page,
} from '@lazyit/shared';
import {
  AUDIT_LOG_CSV_HEADER,
  auditLogCsvRow,
  offsetOf,
  pageOf,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read + filtered CSV export of the three SECURITY audit logs (issue #871, ADR-0081): `SecretAuditLog`,
 * `PermissionAuditLog` and `ServiceAccountAuditLog` — written across the app but, until now, never READ
 * from any endpoint. This is the reader half; the writers stay in their own modules (SecretManager,
 * PermissionsConfig, ServiceAccounts) so the lanes are disjoint.
 *
 * It clones the Reports/activity mold (DashboardService): offset paging (ADR-0030), the same
 * `StreamableFile` + async-generator CSV export that never buffers the whole result, and a
 * `logs:read`-gated actor menu — but source-SCOPED (the three logs have different columns, so a single
 * UNION view would be awkward). Each read narrows ONE source's flat list.
 *
 * INV-10 (ADR-0061): the Secret Manager server can NEVER decrypt. The `SecretAuditLog` rows are already
 * metadata-only. This reader resolves `vaultId`/`itemId` soft-refs to DISPLAY NAMES only, member-blind
 * (no per-vault membership check — the whole surface is `logs:read`/ADMIN-gated, and a name is not a
 * secret), and NEVER selects `ciphertext`/`iv`/`authTag`. A dangling soft-ref (deleted vault/item)
 * degrades to showing the raw id — never a crash, never a value.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rows per round-trip when STREAMING the full filtered export. Mirrors the dashboard's export batch:
   * a bounded skip/take loop over the source's list so the whole range never sits in memory at once.
   *
   * ponytail: OFFSET/LIMIT batching (like the dashboard). CEILING: deep OFFSET is O(offset) per page;
   * fine for an admin audit dump, and unlike the `recent_activity` UNION view these are real tables
   * with a stable autoincrement `id`, so a keyset cursor is a clean future upgrade if ever needed.
   */
  static readonly EXPORT_BATCH_SIZE = 1000;

  /** One paged, filtered page of the chosen source's audit log, newest first (ADR-0030). */
  async getLogs(query: AuditLogQuery): Promise<Page<AuditLogItem>> {
    const { take, skip } = offsetOf(query);
    const [rows, total] = await this.readPage(query, take, skip);
    const items = await this.resolveRows(query.source, rows);
    return pageOf(items, total, query);
  }

  /**
   * Bulk CSV export of the WHOLE filtered range (not just the visible page). Reuses the SAME source
   * WHERE + the SAME name resolution as the page read, and {@link auditLogCsvRow} from `@lazyit/shared`
   * (the one place the RFC-4180 escaping + formula-injection guard live), so the file can never drift
   * from the on-screen list or from the browser "export visible" path. Streamed as an async generator.
   */
  async *streamLogsCsvRows(filters: AuditLogFilters): AsyncGenerator<string> {
    yield `${AUDIT_LOG_CSV_HEADER}\n`;

    let offset = 0;
    for (;;) {
      const [rows] = await this.readPage(
        filters,
        AuditService.EXPORT_BATCH_SIZE,
        offset,
        { withCount: false },
      );
      if (rows.length === 0) break;

      const items = await this.resolveRows(filters.source, rows);
      yield `${items.map(auditLogCsvRow).join('\n')}\n`;

      offset += rows.length;
      // A short batch means the source is exhausted — stop without an extra empty round-trip.
      if (rows.length < AuditService.EXPORT_BATCH_SIZE) break;
    }
  }

  /**
   * The distinct HUMAN actors that actually produced a row for the chosen source (mirrors
   * GET /dashboard/activity/filters, issue #718) — the actor select's menu, so it offers only "who
   * acted", not the whole user directory. Resolved member-blind, includes soft-deleted actors.
   * Actions do NOT come from here: the web derives them from the shared `AUDIT_ACTIONS_BY_SOURCE` enum.
   */
  async getFilterOptions(
    source: AuditLogSource,
  ): Promise<AuditLogFilterOptions> {
    const distinct = await this.distinctActorIds(source);
    if (distinct.length === 0) return { actors: [] };

    const users = await this.prisma.user.findMany({
      where: { id: { in: distinct } },
      select: { id: true, firstName: true, lastName: true },
      // Audit trail: a soft-deleted actor still named (a report keeps its author).
      includeSoftDeleted: true,
    } as Prisma.UserFindManyArgs);

    return {
      actors: users
        .map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}` }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // ── reads ────────────────────────────────────────────────────────────────────

  /**
   * Read one window of the chosen source into the common {@link RawAuditRow} shape, plus the FILTERED
   * total (page read) — both under one snapshot so the count can't drift from the page. `withCount:
   * false` (the export) skips the count. Each branch selects METADATA columns only; the secret branch
   * NEVER selects `ciphertext`/`iv`/`authTag` (there are none on the audit row anyway — belt + braces).
   */
  private async readPage(
    filters: AuditLogFilters,
    take: number,
    skip: number,
    opts: { withCount?: boolean } = {},
  ): Promise<[RawAuditRow[], number]> {
    const withCount = opts.withCount ?? true;
    // Newest first by the append-only autoincrement id — a stable, collision-free order (unlike a
    // shared-millisecond createdAt).
    const orderBy = { id: 'desc' as const };

    switch (filters.source) {
      case 'secret': {
        const where = this.secretWhere(filters);
        const [rows, total] = await this.prisma.$transaction([
          this.prisma.secretAuditLog.findMany({
            where,
            orderBy,
            take,
            skip,
            select: {
              id: true,
              action: true,
              actorId: true,
              serviceAccountId: true,
              vaultId: true,
              itemId: true,
              targetUserId: true,
              targetServiceAccountId: true,
              createdAt: true,
            },
          }),
          withCount
            ? this.prisma.secretAuditLog.count({ where })
            : this.prisma.secretAuditLog.count({ where: { id: -1 } }),
        ]);
        return [rows.map(rawFromSecret), withCount ? total : 0];
      }
      case 'permission': {
        const where = this.permissionWhere(filters);
        const [rows, total] = await this.prisma.$transaction([
          this.prisma.permissionAuditLog.findMany({
            where,
            orderBy,
            take,
            skip,
            select: {
              id: true,
              action: true,
              actorId: true,
              role: true,
              permission: true,
              createdAt: true,
            },
          }),
          withCount
            ? this.prisma.permissionAuditLog.count({ where })
            : this.prisma.permissionAuditLog.count({ where: { id: -1 } }),
        ]);
        return [rows.map(rawFromPermission), withCount ? total : 0];
      }
      case 'serviceAccount': {
        const where = this.serviceAccountWhere(filters);
        const [rows, total] = await this.prisma.$transaction([
          this.prisma.serviceAccountAuditLog.findMany({
            where,
            orderBy,
            take,
            skip,
            select: {
              id: true,
              action: true,
              actorId: true,
              serviceAccountId: true,
              detail: true,
              createdAt: true,
            },
          }),
          withCount
            ? this.prisma.serviceAccountAuditLog.count({ where })
            : this.prisma.serviceAccountAuditLog.count({ where: { id: -1 } }),
        ]);
        return [rows.map(rawFromServiceAccount), withCount ? total : 0];
      }
    }
  }

  /** Distinct non-null `actorId`s present for the chosen source (for the actor filter menu). */
  private async distinctActorIds(source: AuditLogSource): Promise<string[]> {
    const pick = (rows: { actorId: string | null }[]): string[] =>
      rows.map((r) => r.actorId).filter((id): id is string => id !== null);

    switch (source) {
      case 'secret': {
        const rows = await this.prisma.secretAuditLog.findMany({
          where: { actorId: { not: null } },
          select: { actorId: true },
          distinct: ['actorId'],
        });
        return pick(rows);
      }
      case 'permission': {
        const rows = await this.prisma.permissionAuditLog.findMany({
          where: { actorId: { not: null } },
          select: { actorId: true },
          distinct: ['actorId'],
        });
        return pick(rows);
      }
      case 'serviceAccount': {
        const rows = await this.prisma.serviceAccountAuditLog.findMany({
          where: { actorId: { not: null } },
          select: { actorId: true },
          distinct: ['actorId'],
        });
        return pick(rows);
      }
    }
  }

  // ── WHERE builders (typed, per source) ─────────────────────────────────────────

  private secretWhere(f: AuditLogFilters): Prisma.SecretAuditLogWhereInput {
    const where: Prisma.SecretAuditLogWhereInput = {};
    if (f.action !== undefined) {
      where.action = f.action as Prisma.SecretAuditLogWhereInput['action'];
    }
    if (f.actorId !== undefined) where.actorId = f.actorId;
    if (f.serviceAccountId !== undefined) {
      where.serviceAccountId = f.serviceAccountId;
    }
    if (f.vaultId !== undefined) where.vaultId = f.vaultId;
    if (f.itemId !== undefined) where.itemId = f.itemId;
    const createdAt = dateRange(f);
    if (createdAt) where.createdAt = createdAt;
    return where;
  }

  private permissionWhere(
    f: AuditLogFilters,
  ): Prisma.PermissionAuditLogWhereInput {
    const where: Prisma.PermissionAuditLogWhereInput = {};
    if (f.action !== undefined) {
      where.action = f.action as Prisma.PermissionAuditLogWhereInput['action'];
    }
    if (f.actorId !== undefined) where.actorId = f.actorId;
    const createdAt = dateRange(f);
    if (createdAt) where.createdAt = createdAt;
    return where;
  }

  private serviceAccountWhere(
    f: AuditLogFilters,
  ): Prisma.ServiceAccountAuditLogWhereInput {
    const where: Prisma.ServiceAccountAuditLogWhereInput = {};
    if (f.action !== undefined) {
      where.action =
        f.action as Prisma.ServiceAccountAuditLogWhereInput['action'];
    }
    if (f.actorId !== undefined) where.actorId = f.actorId;
    if (f.serviceAccountId !== undefined) {
      where.serviceAccountId = f.serviceAccountId;
    }
    const createdAt = dateRange(f);
    if (createdAt) where.createdAt = createdAt;
    return where;
  }

  // ── name resolution (metadata only, INV-10-safe) ───────────────────────────────

  /**
   * Resolve a batch of raw rows into wire {@link AuditLogItem}s, resolving every id ref to a DISPLAY
   * NAME with as few round-trips as possible (one findMany per referenced entity type over the batch's
   * distinct ids). INV-10: vault/item resolve to `name`/`label` ONLY — never a value; a dangling ref
   * degrades to the raw id. Users/service-accounts include soft-deleted rows so the trail stays named.
   */
  private async resolveRows(
    source: AuditLogSource,
    rows: RawAuditRow[],
  ): Promise<AuditLogItem[]> {
    if (rows.length === 0) return [];

    const userIds = distinct(rows.flatMap((r) => [r.actorId, r.targetUserId]));
    const saIds = distinct(
      rows.flatMap((r) => [r.serviceAccountId, r.targetServiceAccountId]),
    );
    const vaultIds = distinct(rows.map((r) => r.vaultId));
    const itemIds = distinct(rows.map((r) => r.itemId));

    const [users, sas, vaults, items] = await Promise.all([
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, firstName: true, lastName: true },
            includeSoftDeleted: true,
          } as Prisma.UserFindManyArgs)
        : Promise.resolve([]),
      saIds.length
        ? this.prisma.serviceAccount.findMany({
            where: { id: { in: saIds } },
            select: { id: true, name: true, tokenPrefix: true },
            includeSoftDeleted: true,
          } as Prisma.ServiceAccountFindManyArgs)
        : Promise.resolve([]),
      vaultIds.length
        ? // INV-10: SELECT the name only — never ciphertext/keys (a vault has none anyway; the item does).
          this.prisma.secretVault.findMany({
            where: { id: { in: vaultIds } },
            select: { id: true, name: true },
            includeSoftDeleted: true,
          } as Prisma.SecretVaultFindManyArgs)
        : Promise.resolve([]),
      itemIds.length
        ? // INV-10: SELECT the label only — NEVER ciphertext/iv/authTag.
          this.prisma.secretItem.findMany({
            where: { id: { in: itemIds } },
            select: { id: true, label: true },
            includeSoftDeleted: true,
          } as Prisma.SecretItemFindManyArgs)
        : Promise.resolve([]),
    ]);

    const userName = new Map<string, string>(
      (users as { id: string; firstName: string; lastName: string }[]).map(
        (u) => [u.id, `${u.firstName} ${u.lastName}`],
      ),
    );
    const saName = new Map<string, string>(
      (sas as { id: string; name: string; tokenPrefix: string }[]).map((s) => [
        s.id,
        `${s.name} (${s.tokenPrefix})`,
      ]),
    );
    const vaultName = new Map<string, string>(
      (vaults as { id: string; name: string }[]).map((v) => [v.id, v.name]),
    );
    const itemLabel = new Map<string, string>(
      (items as { id: string; label: string }[]).map((i) => [i.id, i.label]),
    );

    return rows.map((r) => ({
      id: r.id,
      source,
      occurredAt: r.createdAt.toISOString(),
      action: r.action,
      actorId: r.actorId,
      // FK-backed: a resolvable name, else null (a hard-deleted actor sets actorId null).
      actorName: r.actorId ? (userName.get(r.actorId) ?? null) : null,
      serviceAccountId: r.serviceAccountId,
      // Soft/FK ref: name-or-raw-id (dangling degrades to the id, never null-when-present).
      serviceAccountName: r.serviceAccountId
        ? (saName.get(r.serviceAccountId) ?? r.serviceAccountId)
        : null,
      vaultId: r.vaultId,
      vaultName: r.vaultId ? (vaultName.get(r.vaultId) ?? r.vaultId) : null,
      itemId: r.itemId,
      itemLabel: r.itemId ? (itemLabel.get(r.itemId) ?? r.itemId) : null,
      targetUserId: r.targetUserId,
      targetUserName: r.targetUserId
        ? (userName.get(r.targetUserId) ?? r.targetUserId)
        : null,
      targetServiceAccountId: r.targetServiceAccountId,
      targetServiceAccountName: r.targetServiceAccountId
        ? (saName.get(r.targetServiceAccountId) ?? r.targetServiceAccountId)
        : null,
      role: r.role,
      permission: r.permission,
      detail: r.detail !== null ? compactJson(r.detail) : null,
    }));
  }
}

/**
 * The common shape every source normalizes into before name resolution — a superset of the three
 * logs' columns, absent columns nulled. Keeps the resolver source-agnostic.
 */
interface RawAuditRow {
  id: number;
  createdAt: Date;
  action: string;
  actorId: string | null;
  serviceAccountId: string | null;
  vaultId: string | null;
  itemId: string | null;
  targetUserId: string | null;
  targetServiceAccountId: string | null;
  role: string | null;
  permission: string | null;
  detail: unknown;
}

function rawFromSecret(row: {
  id: number;
  action: string;
  actorId: string | null;
  serviceAccountId: string | null;
  vaultId: string | null;
  itemId: string | null;
  targetUserId: string | null;
  targetServiceAccountId: string | null;
  createdAt: Date;
}): RawAuditRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    actorId: row.actorId,
    serviceAccountId: row.serviceAccountId,
    vaultId: row.vaultId,
    itemId: row.itemId,
    targetUserId: row.targetUserId,
    targetServiceAccountId: row.targetServiceAccountId,
    role: null,
    permission: null,
    detail: null,
  };
}

function rawFromPermission(row: {
  id: number;
  action: string;
  actorId: string | null;
  role: string;
  permission: string;
  createdAt: Date;
}): RawAuditRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    actorId: row.actorId,
    serviceAccountId: null,
    vaultId: null,
    itemId: null,
    targetUserId: null,
    targetServiceAccountId: null,
    role: row.role,
    permission: row.permission,
    detail: null,
  };
}

function rawFromServiceAccount(row: {
  id: number;
  action: string;
  actorId: string | null;
  serviceAccountId: string;
  detail: unknown;
  createdAt: Date;
}): RawAuditRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    actorId: row.actorId,
    serviceAccountId: row.serviceAccountId,
    vaultId: null,
    itemId: null,
    targetUserId: null,
    targetServiceAccountId: null,
    role: null,
    permission: null,
    detail: row.detail ?? null,
  };
}

/** Closed-open `[from, to)` `createdAt` window from the filters, or undefined when neither bound is set. */
function dateRange(f: AuditLogFilters): Prisma.DateTimeFilter | undefined {
  if (f.from === undefined && f.to === undefined) return undefined;
  const range: Prisma.DateTimeFilter = {};
  if (f.from !== undefined) range.gte = new Date(f.from);
  if (f.to !== undefined) range.lt = new Date(f.to);
  return range;
}

/** Distinct, non-null string ids from a list (helper for the batched name lookups). */
function distinct(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** A compact one-line JSON string for the SA-audit `detail` jsonb (non-secret context). */
function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
