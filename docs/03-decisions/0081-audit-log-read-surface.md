---
title: "ADR-0081: In-app read + CSV export for the security audit logs"
tags: [adr, security, audit, secrets, reports, logs]
status: accepted
created: 2026-07-01
updated: 2026-07-01
deciders: [Joaquín Minatel]
---

# ADR-0081: In-app read + CSV export for the security audit logs

## Status

accepted — issue #871. Reuses the Reports/activity mold ([[0043-dashboard-activity-feed]] /
[[0030-list-pagination-contract]]) and the `logs:read` gate ([[0046-roles-permissions-v2]]). Preserves
the INV-10 zero-knowledge invariant of [[0061-secret-manager-zero-knowledge]]. Explicitly NOT the
declined SIEM sink (#840).

## Context

Three **security audit logs** are written across the app but, until now, read from **no** endpoint or
screen (verified: writes, zero reads):

- `SecretAuditLog` (@@map `secret_audit_logs`) — every Secret Manager action, metadata only
  ([[0061-secret-manager-zero-knowledge]] §10). Written ~16 sites in `SecretManagerService.writeAudit`.
- `PermissionAuditLog` (@@map `permission_audit_log`) — every per-role permission GRANT/REVOKE
  ([[0046-roles-permissions-v2]] P5). Written by `PermissionsConfigService`.
- `ServiceAccountAuditLog` (@@map `service_account_audit_log`) — the SA lifecycle events MINT/ROTATE/
  REVOKE/RESTORE/PERMISSION_CHANGE ([[0048-service-accounts]]).

A compliance reviewer (persona "Priya", CTO triage 2026-06-30) needs to assemble evidence — "who
revealed which secret, when"; "who widened MEMBER's permissions"; "what happened to this service
account" — **without** handing a raw SQL query to a DBA. The Reports feed only unifies asset / access /
stock / user activity (the `recent_activity` view); it deliberately does **not** carry these security
logs. So the app is nominally "auditable by default" but the audit trail is unreadable in-app.

The three logs have **different columns**, so a single `UNION ALL` view (like `recent_activity`) is
awkward — it would either lose per-source columns or bloat every row with mostly-null fields, and the
`action` enums differ per source.

This is **not** #840 (declined) — that was a streaming SIEM sink for an MSP/luxury market. Here it is
self-serve, in-app evidence for a non-DBA reviewer in a **single-org** tool.

### Constraints

- **INV-10** ([[0061-secret-manager-zero-knowledge]]): the Secret Manager server can NEVER decrypt. The
  secret-audit rows already store only metadata (which vault/item/who/when — never a value). Any
  resolution of `vaultId`/`itemId` soft-refs to display names must be **metadata only**, member-blind.
- Auditability by default ([[0006-soft-delete-and-auditing]]): these logs are append-only — the surface
  is read + export ONLY; it never mutates a row.

## Decision

Add a thin, **reader-only** module `apps/api/src/audit/` (`AuditModule` + `AuditController` +
`AuditService`) — the readers live HERE, not in `SecretManagerService` / `DashboardService` (disjoint
lanes; the writers stay in their own modules). Endpoints, all `@RequirePermission('logs:read')`:

- `GET /audit/logs` — a paged (offset, ADR-0030), filtered read of ONE **source** (`secret` |
  `permission` | `serviceAccount`), newest first. Optional filters: `action` (validated against the
  source's enum), `actorId` (a human uuid), `serviceAccountId`, a `[from, to)` date range, and — for
  the secret source only — `vaultId`/`itemId`.
- `GET /audit/logs/export` — the SAME filters, streamed as CSV via `StreamableFile` +
  `Readable.from(asyncGenerator)` (the [[0043-dashboard-activity-feed]] / #840 export mold — never
  buffers the whole result).
- `GET /audit/logs/filters?source=…` — the distinct HUMAN actors present for a source (the actor
  select's menu; mirrors `GET /dashboard/activity/filters`, #718). Actions are NOT returned here.

Key choices:

- **Reuse the `logs:read` permission** (already in `ADMIN_ONLY_READS`, already gates Reports). A NEW
  verb would churn `DEFAULT_ROLE_PERMISSIONS`, the golden permission test, and collide with sibling
  issues — for no gain (the reviewer role is exactly the Reports audience).
- **Source-scoped, not a UNION view.** A required `source` discriminator selects one flat list; the
  wire row is a unified superset shape with per-source fields nulled. The per-vault / per-item
  "timeline" is just a pre-filled `vaultId` / `itemId` FILTER on the secret list (the model already has
  `@@index([vaultId])`), NOT a separate widget.
- **Enum-driven action filters.** `@lazyit/shared` re-exports the three DB action enums
  (`SECRET_AUDIT_ACTIONS`, `PERMISSION_AUDIT_LOG_ACTIONS`, `SERVICE_ACCOUNT_AUDIT_ACTIONS` +
  `AUDIT_ACTIONS_BY_SOURCE`) as the single source of truth. The frontend action dropdown reads them, so
  a newly-added DB enum value (e.g. #870's `ITEM_REVEALED`) appears automatically — no frontend edit.
  (The wire uses the DB-native UPPERCASE labels for all three sources, so the read needs no case
  transform. This is deliberately distinct from the pre-existing lowercase `PermissionAuditActionSchema`
  that types the `PUT /config/permissions` EDIT surface — hence the `_LOG_`-suffixed permission symbols
  to avoid a barrel collision.)
- **INV-10-safe metadata resolution.** The secret reader resolves `vaultId` → vault name and `itemId` →
  item label with a `SELECT` of the name/label columns ONLY (never `ciphertext`/`iv`/`authTag`),
  member-blind (no per-vault membership check — the whole surface is `logs:read`/ADMIN-gated, and a name
  is not a secret). Actors and service accounts resolve to a display name (SA → "name (prefix)"),
  including soft-deleted rows so the trail stays named. A **dangling** soft-ref (deleted vault/item)
  degrades to showing the raw id — never null-when-present, never a crash, never a value. The wire row
  has **no value column at all**, so a secret's plaintext can never appear (in the API or the CSV).
- **One shared CSV util.** `@lazyit/shared` `utils/audit-log-csv.ts` REUSES `escapeCsvCell` (RFC-4180 +
  the spreadsheet formula-injection guard) from `recent-activity-csv.ts` — the guard lives in one place
  and can't drift between the browser "export visible" path and the server "export all" stream.

The frontend is a sibling route `/reports/audit` (a sibling of the Reports activity feed, same
`logs:read` gate) that reuses the Reports ledger-tape list, the Export-all(filtered)/Export-visible/
Print buttons, and the server-side filter bar. A new **Audit log** nav item sits under Reports.

## Consequences

- The three security logs are finally readable + exportable in-app; a reviewer assembles evidence
  without a DBA. The per-vault/per-item timeline is a deep-linkable filter.
- No schema change, no migration, no new permission verb — additive only.
- INV-10 is preserved and pinned by a unit test (the secret read/export returns metadata only and never
  selects the ciphertext columns).
- **Ceilings / follow-ups (deliberate v1 shortcuts):**
  - Offset paging (like Reports v1). The export is streamed so bulk is fine; a keyset cursor is a clean
    future upgrade (these are real tables with a stable autoincrement `id`, unlike the UNION view).
  - The frontend action-chip label is a locale-neutral title-case of the enum token (no per-locale
    label map). Add `audit.action.*` i18n keys if a translated label is ever wanted.
  - The `vaultId`/`itemId`/`serviceAccountId` filters are URL/deep-link driven (surfaced as active-filter
    chips), not pickers — sufficient for the "timeline" use; a vault/item picker is a later nicety.
- NOT #840: no streaming SIEM sink, no retention policy, no embedded per-entity widget.
