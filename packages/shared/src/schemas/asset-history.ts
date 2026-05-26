import { z } from "zod";
import { int4 } from "./primitives";

/**
 * AssetHistory — an append-only log of discrete state changes for an Asset (ADR-0033). Single
 * source of truth for api and web. See docs/02-domain/entities/asset-history.md.
 *
 * Date fields are ISO-8601 strings (wire shape). `id` is a numeric autoincrement (a log id).
 */

/** The discrete asset events recorded in AssetHistory. */
export const AssetHistoryEventTypeSchema = z.enum([
  "CREATED",
  "STATUS_CHANGED",
  "ASSIGNED",
  "RELEASED",
  "LOCATION_CHANGED",
  "MODEL_CHANGED",
  "SPECS_CHANGED",
  "DELETED",
  "RESTORED",
]);

/** Contextual data attached to an event (e.g. `{ from, to }`, `{ userId }`). Unvalidated jsonb. */
const AssetHistoryPayloadSchema = z.record(z.string(), z.unknown());

/** A single AssetHistory row (API representation of the `asset_history` row). */
export const AssetHistorySchema = z.object({
  id: int4(),
  assetId: z.cuid(),
  eventType: AssetHistoryEventTypeSchema,
  payload: AssetHistoryPayloadSchema.nullable(),
  performedById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * Query params for `GET /assets/:id/history` — newest first, cursor on the autoincrement id.
 * `before` returns rows with `id < before`; `limit` defaults to 50 (max 100).
 */
export const AssetHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export type AssetHistoryEventType = z.infer<typeof AssetHistoryEventTypeSchema>;
export type AssetHistory = z.infer<typeof AssetHistorySchema>;
export type AssetHistoryQuery = z.infer<typeof AssetHistoryQuerySchema>;
