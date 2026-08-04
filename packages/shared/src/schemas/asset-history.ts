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
  // UPDATED — a whole-asset update with no per-dimension delta to record; today it is the "updated via
  // re-import" marker the migrator stamps so a no-field-change re-import still lands one audit row (#1061).
  // Mirrors UserHistoryEventType.UPDATED.
  "UPDATED",
  "STATUS_CHANGED",
  "ASSIGNED",
  "RELEASED",
  "LOCATION_CHANGED",
  "MODEL_CHANGED",
  "SPECS_CHANGED",
  "DELETED",
  "RESTORED",
  // Check-out acknowledgement — the assignee confirmed they hold the asset (ADR-0089 Part B, #1029).
  // Emitted by POST /asset-assignments/:id/acknowledge; payload { userId } = the acknowledging owner.
  "ACKNOWLEDGED",
  // An agent-reported InfraNode ADOPTED this asset at its confirm gate (ADR-0093 §4, #1198): a machine
  // started writing to a row a human curated. Payload `{ nodeId, reportingSource, externalId }`.
  //
  // EXACTLY ONE PER LINK, and that bound is the whole design. The recurring path (`syncAssetSpecs`)
  // deliberately emits NO per-report event — an agent checks in every five minutes, and an event per
  // report would bury every human edit this asset ever received under thousands of machine rows. What
  // MOVED is audited on the node instead (InfraNodeFactChange, #1143), one join away. This event
  // answers the one question a human reading a curated asset's history actually asks: *when did a
  // machine start writing to this row, and which one?*
  "AGENT_LINKED",
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
