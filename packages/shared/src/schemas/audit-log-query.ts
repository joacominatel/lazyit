import { z } from "zod";
import { pageSchema, PageQuerySchema } from "./pagination";

/**
 * Audit-log READ surface (issue #871) — the in-app, admin-only read + filtered CSV export of the three
 * SECURITY audit logs that are written but never read: `SecretAuditLog`, `PermissionAuditLog` and
 * `ServiceAccountAuditLog`. It clones the Reports/activity contract (offset paging + a shared filter
 * bar + a streamed CSV export) rather than inventing new machinery — see ADR-0081 and
 * docs/02-domain/entities/recent-activity.md for the mold. Gated on the SAME `logs:read` permission
 * that gates Reports (no new verb).
 *
 * The three logs have DIFFERENT columns, so this is a SOURCE-SCOPED design (a required `source`
 * discriminator), NOT a forced UNION view. Every read/export narrows one source's flat list; the
 * per-vault / per-item "timeline" is just a pre-filled `vaultId` / `itemId` filter on the secret list.
 *
 * INV-10 (ADR-0061): the Secret Manager server can NEVER decrypt. The secret-audit rows already store
 * only metadata (which vault/item/who/when). When the API resolves `vaultId`/`itemId` soft-refs to
 * display names it resolves METADATA ONLY, member-blind — NEVER plaintext, ciphertext, a DEK or a
 * wrapped key. A dangling soft-ref (deleted vault/item) degrades to showing the id, never a crash.
 *
 * NOT the declined #840 SIEM sink: this is self-serve, in-app evidence for a non-DBA auditor in a
 * single-org tool.
 */

/** The three security audit logs this surface reads. The `source` discriminator selects one. */
export const AUDIT_LOG_SOURCES = [
  "secret",
  "permission",
  "serviceAccount",
] as const;
export const AuditLogSourceSchema = z.enum(AUDIT_LOG_SOURCES);
export type AuditLogSource = z.infer<typeof AuditLogSourceSchema>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Per-source action enums — the UPPERCASE labels are the RAW Postgres enum values each log column
 * stores, mirrored here so the frontend action filter is ENUM-DRIVEN (never a hardcoded list). Keeping
 * them here means a new DB enum value (e.g. #870's `ITEM_REVEALED`) appears in the filter dropdown the
 * moment it is added to this array — no frontend edit. Keep in sync with the prisma schema enums.
 *
 * The wire is the DB-native uppercase for ALL THREE sources so the read needs no case transform in
 * either direction. NOTE: this is distinct from the pre-existing lowercase `PermissionAuditActionSchema`
 * in schemas/permission.ts, which types the PUT /config/permissions EDIT surface — a different concern
 * from this read surface; the two intentionally do not share a symbol.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** `SecretAuditAction` (prisma) — every Secret Manager action recorded, METADATA ONLY (ADR-0061 §10). */
export const SECRET_AUDIT_ACTIONS = [
  "VAULT_CREATED",
  "VAULT_DELETED",
  "ITEM_CREATED",
  "ITEM_UPDATED",
  "ITEM_DELETED",
  "MEMBERSHIP_GRANTED",
  "MEMBERSHIP_REVOKED",
  "KEYPAIR_CREATED",
  "KEYPAIR_RESET",
  "PASSWORD_CHANGED",
  "RECOVERY_KEY_REGENERATED",
  "ITEMS_EXPORTED",
  "SA_KEYPAIR_CREATED",
  "ITEMS_FETCHED",
  // A human member revealed a single item's value in the UI (#870, ADR-0080). Metadata only.
  "ITEM_REVEALED",
] as const;
export const SecretAuditActionSchema = z.enum(SECRET_AUDIT_ACTIONS);
export type SecretAuditAction = z.infer<typeof SecretAuditActionSchema>;

/**
 * `PermissionAuditAction` (prisma) — the direction of a per-role permission edit (ADR-0046 P5). Named
 * with a `_LOG_` distinction to avoid colliding with the pre-existing lowercase `PERMISSION_AUDIT_ACTIONS`
 * / `PermissionAuditActionSchema` in schemas/permission.ts (the PUT /config/permissions EDIT surface,
 * lowercase-on-the-wire). This read surface uses the DB-native UPPERCASE labels (no case transform).
 */
export const PERMISSION_AUDIT_LOG_ACTIONS = ["GRANT", "REVOKE"] as const;
export const PermissionAuditLogActionSchema = z.enum(
  PERMISSION_AUDIT_LOG_ACTIONS,
);
export type PermissionAuditLogAction = z.infer<
  typeof PermissionAuditLogActionSchema
>;

/** `ServiceAccountAuditAction` (prisma) — the SA lifecycle events (ADR-0048). */
export const SERVICE_ACCOUNT_AUDIT_ACTIONS = [
  "MINT",
  "ROTATE",
  "REVOKE",
  "RESTORE",
  "PERMISSION_CHANGE",
] as const;
export const ServiceAccountAuditActionSchema = z.enum(
  SERVICE_ACCOUNT_AUDIT_ACTIONS,
);
export type ServiceAccountAuditAction = z.infer<
  typeof ServiceAccountAuditActionSchema
>;

/**
 * The closed action allowlist PER SOURCE — the single source of truth for BOTH the `action` filter's
 * server-side validation (an action not in the selected source's set is a 400) AND the frontend's
 * enum-driven action dropdown (the options for the active source tab).
 */
export const AUDIT_ACTIONS_BY_SOURCE = {
  secret: SECRET_AUDIT_ACTIONS,
  permission: PERMISSION_AUDIT_LOG_ACTIONS,
  serviceAccount: SERVICE_ACCOUNT_AUDIT_ACTIONS,
} as const satisfies Record<AuditLogSource, readonly string[]>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * The filterable query — the OPTIONAL filters layered on the ADR-0030 pagination contract, mirroring
 * RecentActivityFiltersSchema. `source` is REQUIRED (it selects which log to read). Every other field
 * is optional; the API applies each as a parameterized WHERE and counts the SAME filtered set.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** The optional, additive audit-log filters (source-scoped). */
export const AuditLogFiltersSchema = z
  .object({
    // REQUIRED — which of the three logs to read.
    source: AuditLogSourceSchema,
    // One action label valid for the chosen `source` (validated in the refine → 400 otherwise).
    action: z.string().trim().min(1).optional(),
    // A concrete HUMAN actor uuid (the User who acted). Not resolved to "me" — this is an admin review.
    actorId: z.uuid().optional(),
    // A SERVICE-ACCOUNT id (cuid). On `secret` it filters the SA ACTOR (ITEMS_FETCHED); on
    // `serviceAccount` it filters the SUBJECT SA (the per-SA timeline). Invalid on `permission`.
    serviceAccountId: z.string().trim().min(1).optional(),
    // Secret-only: the per-vault timeline (exact match). Invalid on the other sources.
    vaultId: z.string().trim().min(1).optional(),
    // Secret-only: the per-item timeline (exact match). Invalid on the other sources.
    itemId: z.string().trim().min(1).optional(),
    // Inclusive lower bound of the `createdAt` window (closed-open `[from, to)`).
    from: z.iso.datetime().optional(),
    // Exclusive upper bound of the `createdAt` window (closed-open `[from, to)`).
    to: z.iso.datetime().optional(),
  })
  .superRefine((val, ctx) => {
    // `action` must be one of the SELECTED source's labels (so a `permission` query can't ask for a
    // secret action, etc.). Enum-driven from AUDIT_ACTIONS_BY_SOURCE.
    if (val.action !== undefined) {
      const allowed = AUDIT_ACTIONS_BY_SOURCE[val.source] as readonly string[];
      if (!allowed.includes(val.action)) {
        ctx.addIssue({
          code: "custom",
          path: ["action"],
          message: `action must be one of ${allowed.join(", ")} for source "${val.source}"`,
        });
      }
    }
    // vaultId/itemId are secret-only metadata refs.
    if (val.source !== "secret") {
      for (const key of ["vaultId", "itemId"] as const) {
        if (val[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} filter is only valid for source "secret"`,
          });
        }
      }
    }
    // permission rows carry no service-account column.
    if (val.source === "permission" && val.serviceAccountId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["serviceAccountId"],
        message: 'serviceAccountId filter is not valid for source "permission"',
      });
    }
  });
export type AuditLogFilters = z.infer<typeof AuditLogFiltersSchema>;

/**
 * The full filterable `GET /audit/logs` query: the OPTIONAL audit filters COMPOSED with the shared
 * pagination contract (ADR-0030 `limit`/`offset`/`page`), exactly like RecentActivityQuerySchema.
 * PageQuerySchema carries a `.transform()`, so this composes by INTERSECTION.
 */
export const AuditLogQuerySchema = z.intersection(
  PageQuerySchema,
  AuditLogFiltersSchema,
);
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * The response row — a UNIFIED, flat shape across the three sources. Fields not relevant to a given
 * source are null (a permission row has no vault; a secret row has no permission). Soft-refs are
 * resolved to METADATA display names server-side; a dangling ref degrades to its raw id (never null vs
 * crash), and a secret row NEVER carries plaintext/ciphertext (INV-10).
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
export const AuditLogItemSchema = z.object({
  // The autoincrement log-row id — used as a stable list key (the rows are append-only, never exposed
  // as a routable resource id, so surfacing it here is safe — ADR-0005).
  id: z.number().int(),
  // Which log this row came from.
  source: AuditLogSourceSchema,
  // ISO-8601 timestamp the event was recorded at (the row's `createdAt`). Newest first.
  occurredAt: z.iso.datetime(),
  // The raw action label (uppercase, from the source's enum). The web humanizes it for display.
  action: z.string(),
  // The HUMAN actor (uuid) + resolved display name, or null for a system/SA-actor/deleted actor.
  actorId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  // The SERVICE ACCOUNT involved — the SA actor (secret ITEMS_FETCHED) or the subject SA
  // (serviceAccount source). Resolved to "name (prefix…)"; a dangling ref shows the raw id.
  serviceAccountId: z.string().nullable(),
  serviceAccountName: z.string().nullable(),
  // Secret-source metadata (INV-10: names ONLY, member-blind). Dangling → the raw id in *Name.
  vaultId: z.string().nullable(),
  vaultName: z.string().nullable(),
  itemId: z.string().nullable(),
  itemLabel: z.string().nullable(),
  // Secret-source targets — the user or SA the event concerned (membership grant/revoke, etc.).
  targetUserId: z.uuid().nullable(),
  targetUserName: z.string().nullable(),
  targetServiceAccountId: z.string().nullable(),
  targetServiceAccountName: z.string().nullable(),
  // Permission-source metadata: the role whose set changed and the permission literal edited.
  role: z.string().nullable(),
  permission: z.string().nullable(),
  // ServiceAccount-source non-secret context (e.g. the permission delta), pre-serialized to a compact
  // one-line string for display/CSV. NEVER a secret (the SA audit never records one).
  detail: z.string().nullable(),
});
export type AuditLogItem = z.infer<typeof AuditLogItemSchema>;

/** Paginated `GET /audit/logs` envelope: `{ items, total, limit, offset }` (ADR-0030). */
export const AuditLogPageSchema = pageSchema(AuditLogItemSchema);
export type AuditLogPage = z.infer<typeof AuditLogPageSchema>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Filter OPTIONS (mirrors GET /dashboard/activity/filters, issue #718): the distinct HUMAN actors that
 * actually produced a row for the chosen source, so the actor select offers only "who acted" — not the
 * whole directory. Actions do NOT come from here: they are enum-driven from AUDIT_ACTIONS_BY_SOURCE.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
export const AuditLogActorOptionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});
export type AuditLogActorOption = z.infer<typeof AuditLogActorOptionSchema>;

export const AuditLogFilterOptionsSchema = z.object({
  actors: z.array(AuditLogActorOptionSchema),
});
export type AuditLogFilterOptions = z.infer<typeof AuditLogFilterOptionsSchema>;
