import { z } from "zod";
import { int4 } from "./primitives";

/**
 * UserHistory — an append-only log of discrete lifecycle events for a User (DEBT-2, issue #185). The
 * User entity's own audit trail, the counterpart of AssetHistory for the asset (ADR-0033 / ADR-0006).
 * Single source of truth for api and web. See docs/02-domain/entities/user.md + ADR-0050.
 *
 * Date fields are ISO-8601 strings (wire shape). `id` is a numeric autoincrement (a log id).
 */

/**
 * The discrete user-lifecycle events recorded in UserHistory. Mirrors AssetHistoryEventType's
 * CREATED / UPDATED / DELETED / RESTORED set, plus the user-specific ROLE_CHANGED, MANAGER_CHANGED
 * (ADR-0058 — payload `{ from, to }`, each side a user-id | external-name | null) and
 * PASSWORD_RESET_SENT. Lowercased, these are the `action` verbs the `user` branch of the
 * `recent_activity` view emits (kept in sync with RECENT_ACTIVITY_ACTIONS).
 */
export const UserHistoryEventTypeSchema = z.enum([
  "CREATED",
  "UPDATED",
  "ROLE_CHANGED",
  "MANAGER_CHANGED",
  "DELETED",
  "RESTORED",
  "PASSWORD_RESET_SENT",
]);

/** Contextual data attached to an event (e.g. `{ from, to }` on ROLE_CHANGED). Unvalidated jsonb. */
const UserHistoryPayloadSchema = z.record(z.string(), z.unknown());

/** A single UserHistory row (API representation of the `user_history` row). */
export const UserHistorySchema = z.object({
  id: int4(),
  userId: z.uuid(),
  eventType: UserHistoryEventTypeSchema,
  payload: UserHistoryPayloadSchema.nullable(),
  performedById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * Query params for a future `GET /users/:id/history` — newest first, cursor on the autoincrement id.
 * `before` returns rows with `id < before`; `limit` defaults to 50 (max 100). Mirrors
 * AssetHistoryQuerySchema so the read endpoint, when added, is contract-identical.
 */
export const UserHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export type UserHistoryEventType = z.infer<typeof UserHistoryEventTypeSchema>;
export type UserHistory = z.infer<typeof UserHistorySchema>;
export type UserHistoryQuery = z.infer<typeof UserHistoryQuerySchema>;
