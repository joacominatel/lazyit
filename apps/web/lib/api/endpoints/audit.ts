import type {
  AuditLogFilterOptions,
  AuditLogPage,
  AuditLogSource,
} from "@lazyit/shared";
import { apiFetch, apiFetchBlob } from "../client";

/**
 * Data-access for the security audit-log READ surface (issue #871, ADR-0081) — the reader for the
 * three security audit logs (`SecretAuditLog`, `PermissionAuditLog`, `ServiceAccountAuditLog`), which
 * are written across the app but were never readable. Mirrors `endpoints/dashboard.ts` (the Reports
 * mold): a paged+filtered read, a streaming CSV export, and a distinct-actor filter menu — all gated on
 * `logs:read` server-side (the same gate as Reports).
 *
 * Source-SCOPED: every call carries a required `source`. Secret rows come back with vault/item resolved
 * to METADATA display names only (INV-10) — there is never a secret value. See `@lazyit/shared`
 * `schemas/audit-log-query.ts` for the contract.
 */

const BASE = "/audit";

/**
 * The optional server-side filters for one audit source (mirrors `AuditLogFilters`, less `source` and
 * the pagination window). Every field is optional; the API validates `action` against the source's
 * enum and rejects `vaultId`/`itemId` on a non-secret source. `from`/`to` are ISO-8601 (closed-open).
 */
export interface AuditLogClientFilters {
  /** One action label valid for the active source (e.g. `ITEM_REVEALED`, `GRANT`, `MINT`). */
  action?: string;
  /** A concrete human actor uuid. */
  actorId?: string;
  /** A service-account id (the SA actor on `secret`; the subject SA on `serviceAccount`). */
  serviceAccountId?: string;
  /** Secret source only — the per-vault timeline. */
  vaultId?: string;
  /** Secret source only — the per-item timeline. */
  itemId?: string;
  /** Inclusive lower bound (ISO-8601) of the `createdAt` window. */
  from?: string;
  /** Exclusive upper bound (ISO-8601) of the `createdAt` window. */
  to?: string;
}

/** Window + filters for the paged read. `source` is required; omit paging for the server default. */
export interface AuditLogParams extends AuditLogClientFilters {
  source: AuditLogSource;
  /** Page size (1-200). Omit for the server default (50). */
  limit?: number;
  /** Zero-based window offset. Omit for the first page. */
  offset?: number;
}

/** Append every present filter to the search params (shared by the read + export serializers). */
function appendFilters(
  params: URLSearchParams,
  filters: AuditLogClientFilters,
): void {
  if (filters.action) params.set("action", filters.action);
  if (filters.actorId) params.set("actorId", filters.actorId);
  if (filters.serviceAccountId)
    params.set("serviceAccountId", filters.serviceAccountId);
  if (filters.vaultId) params.set("vaultId", filters.vaultId);
  if (filters.itemId) params.set("itemId", filters.itemId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
}

/**
 * Fetch one page of a security audit log (`GET /audit/logs`), newest first. Returns the whole
 * `Page<AuditLogItem>` envelope (`items` + `total`/`limit`/`offset`) so the caller can compute "has
 * more". `token` is the optional SSR Bearer override (ADR-0067), mirroring the dashboard endpoints.
 */
export function getAuditLogs(
  { source, limit, offset, ...filters }: AuditLogParams,
  token?: string,
): Promise<AuditLogPage> {
  const params = new URLSearchParams({ source });
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  appendFilters(params, filters);
  return apiFetch<AuditLogPage>(`${BASE}/logs?${params.toString()}`, { token });
}

/**
 * Fetch the distinct human actors present for a source (`GET /audit/logs/filters`) — the actor
 * select's menu. Actions are NOT fetched: the web derives them from the shared per-source action enum.
 */
export function getAuditLogFilters(
  source: AuditLogSource,
): Promise<AuditLogFilterOptions> {
  return apiFetch<AuditLogFilterOptions>(
    `${BASE}/logs/filters?source=${source}`,
  );
}

/**
 * Download the WHOLE filtered range of one audit source as a CSV blob (`GET /audit/logs/export`).
 * Serializes the SAME filters as {@link getAuditLogs} (no paging — the export streams every matching
 * row server-side). The RFC-4180 escaping + formula-injection guard are applied server-side.
 */
export function downloadAuditLogExport(
  source: AuditLogSource,
  filters: AuditLogClientFilters = {},
): Promise<Blob> {
  const params = new URLSearchParams({ source });
  appendFilters(params, filters);
  return apiFetchBlob(`${BASE}/logs/export?${params.toString()}`);
}
