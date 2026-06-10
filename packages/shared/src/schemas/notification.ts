import { z } from "zod";
import { pageSchema } from "./pagination";

/**
 * Notification — the in-app notification bell (ADR-0056). The single source of truth for `api`
 * (emit + response typing) and `web` (render) of the curated operational nudges an admin sees in the
 * topbar bell. See docs/03-decisions/0056-in-app-notification-bell.md.
 *
 * Model in one line: each `Notification` is an **append-only event** (one immutable row per logical
 * thing-an-admin-should-glance-at), and read state is a **per-admin join** computed fan-out-on-READ.
 * This file is only the WIRE contract — the Prisma models + the per-admin `NotificationRead` join live
 * in `apps/api`. The list endpoint folds each notification's per-caller `read` flag into the item shape
 * below, so the web never stitches two lists.
 *
 * v1 is POLL-only (`GET /notifications` + `GET /notifications/unread-count`); SSE is a Phase-2 upgrade
 * behind the SAME endpoints and the SAME wire shapes (ADR-0056 §2) — so these types do not change when
 * realtime lands.
 *
 * Notifications are **operational nudges, not the audit system-of-record** — the append-only history
 * tables and ledgers remain that, and the bell is allowed to forget (a 90-day retention sweep on the
 * API side). Anything carried in `metadata` is REDACTED (names/ids only, never bodies/secrets — INV-6,
 * ADR-0031).
 */

/**
 * The CLOSED catalog of notification types (catalog-as-code, the same instinct as the permission
 * catalog and the workflow enums). A typo can't mint a type; CI fails on an unknown literal; `api`
 * (emit) and `web` (render a closed set of icons/copy) agree by construction. Adding a type later is an
 * additive shared-package change. The v1 triggers (ADR-0056 §3):
 *   - `critical_app_access` — a grant opened access to an application flagged `isCritical`.
 *   - `admin_granted`       — a grant/role change raised a user to the ADMIN role.
 *   - `low_stock`           — a consumable crossed from above its `minStock` to at/below it.
 *   - `workflow.manual_task`— a workflow run paused for a human (a ManualTask was created).
 *   - `workflow.run_failed` — a workflow run failed/escalated and stopped (ADR-0054 §8).
 */
export const NOTIFICATION_TYPES = [
  "critical_app_access",
  "admin_granted",
  "low_stock",
  "workflow.manual_task",
  "workflow.run_failed",
] as const;

/** A single known notification type. The wire shape validates against this enum (→ 400 otherwise). */
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/**
 * The severity of a notification — a small, closed ramp the bell uses to tint a row / weight an icon.
 * Deliberately NOT a graded business criticality (ADR-0056 out-of-scope: the only criticality input is
 * the existing `Application.isCritical` boolean). It is purely a presentation cue:
 *   - `info`     — a normal nudge (e.g. a manual task is waiting).
 *   - `warning`  — something an admin should look at soon (low stock, critical-app access).
 *   - `critical` — something likely wrong (a failed workflow run).
 */
export const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;
export const NotificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

/**
 * The deep-link target pillar a notification points at — what the bell row click-through navigates to.
 * Mirrors the `recent_activity` entity-type instinct but is its OWN closed set (notifications are a
 * distinct store): a grant/admin-grant points at the user/application, low stock at the consumable, a
 * workflow nudge at the run (the manual-task inbox / run timeline). `null` entityType ⇒ no click-through.
 */
export const NOTIFICATION_ENTITY_TYPES = [
  "application",
  "user",
  "consumable",
  "workflowRun",
] as const;
export const NotificationEntityTypeSchema = z.enum(NOTIFICATION_ENTITY_TYPES);
export type NotificationEntityType = z.infer<
  typeof NotificationEntityTypeSchema
>;

/**
 * One notification as the bell renders it — the immutable event PLUS the per-caller `read` flag the
 * list endpoint folds in (fan-out-on-read: `read` is true iff a `NotificationRead` row exists for the
 * calling admin). All date fields are ISO-8601 strings (wire shape). Fields:
 *   - `id`         — the stable per-row cuid (this is what `PATCH /notifications/:id/read` addresses;
 *                    the `recent_activity` view deliberately has NO such id — ADR-0056 §Context).
 *   - `type`       — the closed catalog type (drives the icon + copy).
 *   - `severity`   — the presentation ramp (tint/weight).
 *   - `title`      — a short, human, server-built headline.
 *   - `summary`    — an optional one-line clarifier under the title.
 *   - `entityType` / `entityId` — the deep-link target (both null ⇒ no click-through).
 *   - `targetUserId` — the user the nudge is ABOUT (the grantee / the elevated user), for a secondary
 *                    click-through; null when the nudge has no person subject (low stock, run failure).
 *   - `metadata`   — small, REDACTED extra context (names/ids only) the web may use to enrich the row;
 *                    never bodies/secrets/PII (INV-6). Optional and free-shape jsonb on the wire.
 *   - `read`       — the per-caller read flag (folded in by the list endpoint).
 *   - `createdAt`  — when the event was recorded. The feed is newest-first by this.
 */
export const NotificationSchema = z.object({
  id: z.string(),
  type: NotificationTypeSchema,
  severity: NotificationSeveritySchema,
  title: z.string(),
  summary: z.string().nullable(),
  entityType: NotificationEntityTypeSchema.nullable(),
  entityId: z.string().nullable(),
  targetUserId: z.uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * Paginated `GET /notifications` envelope: `{ items: Notification[], total, limit, offset }`. Offset
 * pagination per ADR-0030 — NOT a bare array. Newest-first; `total` is the count over the caller's
 * whole (retained) notification set. Each item carries its per-caller `read` flag.
 */
export const NotificationPageSchema = pageSchema(NotificationSchema);
export type NotificationPage = z.infer<typeof NotificationPageSchema>;

/**
 * `GET /notifications/unread-count` response — the badge number. One field so the shape can grow (e.g. a
 * per-type breakdown) without a breaking change. The count is the anti-join over the caller's unread
 * notifications (a `Notification` with no `NotificationRead` row for the caller, within retention).
 */
export const UnreadCountSchema = z.object({
  unread: z.number().int().min(0),
});
export type UnreadCount = z.infer<typeof UnreadCountSchema>;

/**
 * The result of a mark-read action (`PATCH /notifications/:id/read` and `PATCH /notifications/read-all`)
 * — the fresh unread count so the bell badge updates without a second round-trip, plus how many rows the
 * action newly marked read (0 when the single item was already read, or when mark-all found nothing
 * unread). Mark-read is idempotent: re-marking an already-read notification succeeds with `marked: 0`.
 */
export const MarkReadResultSchema = z.object({
  /** How many notifications this action transitioned from unread → read (idempotent: may be 0). */
  marked: z.number().int().min(0),
  /** The caller's unread count AFTER the action — drives the badge without a refetch. */
  unread: z.number().int().min(0),
});
export type MarkReadResult = z.infer<typeof MarkReadResultSchema>;
