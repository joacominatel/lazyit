-- Recent activity feed (CEO Round 2, ADR-0043): a unified, cross-pillar activity stream for the
-- dashboard, normalizing the FOUR append-only activity sources into one chronologically-ordered
-- read model. The CEO asked for this explicitly as a VIEW ("podemos hacerlo con una view").
--
-- Prisma cannot express a UNION view in PSL, so the view lives here as raw SQL (the same
-- "SQL Prisma can't represent" pattern as the partial unique indexes — see
-- docs/05-runbooks/prisma-migrations.md §3). It is purely DERIVED: no table changes, nothing writes
-- to it, and Prisma does not track it (so `migrate diff --exit-code` stays green). The API reads it
-- with a typed `$queryRaw`. Drop-only on rollback — recreated by re-running the migration.
--
-- Normalized row contract (consumed by @lazyit/shared RecentActivityItemSchema):
--   occurredAt timestamptz · actorId uuid? · entityType text · entityId text · action text · summary text
--
-- Soft delete (ADR-0032): the soft-delete query extension does NOT touch raw SQL, so this view must
-- filter deleted parents itself. Every branch joins to its parent entity and keeps only rows whose
-- parent is LIVE (`deletedAt IS NULL`) — a soft-deleted asset/application/consumable drops out of the
-- feed, matching the rest of the dashboard. AssetHistory/AssetAssignment/AccessGrant/ConsumableMovement
-- are themselves append-only (no deletedAt), so only the parent's soft-delete is relevant.
--
-- Column names are camelCase (lazyit maps only table names via @@map, not columns) and must be quoted.

CREATE VIEW "recent_activity" AS
-- 1) AssetHistory — discrete asset state changes (ADR-0033). The event verb is lowercased; the
--    summary is a terse, human-readable line. entityType = 'asset'.
SELECT
  ah."createdAt"::timestamptz                 AS "occurredAt",
  ah."performedById"                          AS "actorId",
  'asset'                                     AS "entityType",
  ah."assetId"                                AS "entityId",
  lower(ah."eventType"::text)                 AS "action",
  'Asset ' || lower(replace(ah."eventType"::text, '_', ' ')) AS "summary"
FROM "asset_history" ah
JOIN "assets" a ON a."id" = ah."assetId" AND a."deletedAt" IS NULL

UNION ALL

-- 2) AssetAssignment — ownership opened (assigned). entityType = 'asset'. assignedAt is always set.
SELECT
  aa."assignedAt"::timestamptz                AS "occurredAt",
  aa."assignedById"                           AS "actorId",
  'asset'                                     AS "entityType",
  aa."assetId"                                AS "entityId",
  'assigned'                                  AS "action",
  'Asset assigned to a user'                  AS "summary"
FROM "asset_assignments" aa
JOIN "assets" a ON a."id" = aa."assetId" AND a."deletedAt" IS NULL

UNION ALL

-- 2b) AssetAssignment — ownership closed (released). Only rows that have actually been released.
SELECT
  aa."releasedAt"::timestamptz                AS "occurredAt",
  aa."releasedById"                           AS "actorId",
  'asset'                                     AS "entityType",
  aa."assetId"                                AS "entityId",
  'released'                                  AS "action",
  'Asset released from a user'                AS "summary"
FROM "asset_assignments" aa
JOIN "assets" a ON a."id" = aa."assetId" AND a."deletedAt" IS NULL
WHERE aa."releasedAt" IS NOT NULL

UNION ALL

-- 3) AccessGrant — access opened (granted). entityType = 'application'. grantedAt is always set.
SELECT
  ag."grantedAt"::timestamptz                 AS "occurredAt",
  ag."grantedById"                            AS "actorId",
  'application'                               AS "entityType",
  ag."applicationId"                          AS "entityId",
  'granted'                                   AS "action",
  'Access granted to a user'                  AS "summary"
FROM "access_grants" ag
JOIN "applications" ap ON ap."id" = ag."applicationId" AND ap."deletedAt" IS NULL

UNION ALL

-- 3b) AccessGrant — access closed (revoked). Only rows that have actually been revoked.
SELECT
  ag."revokedAt"::timestamptz                 AS "occurredAt",
  ag."revokedById"                            AS "actorId",
  'application'                               AS "entityType",
  ag."applicationId"                          AS "entityId",
  'revoked'                                   AS "action",
  'Access revoked from a user'                AS "summary"
FROM "access_grants" ag
JOIN "applications" ap ON ap."id" = ag."applicationId" AND ap."deletedAt" IS NULL
WHERE ag."revokedAt" IS NOT NULL

UNION ALL

-- 4) ConsumableMovement — stock ledger entries (ADR-0034). entityType = 'consumable'. The action
--    encodes the direction; the summary states the signed quantity.
SELECT
  cm."createdAt"::timestamptz                 AS "occurredAt",
  cm."performedById"                          AS "actorId",
  'consumable'                                AS "entityType",
  cm."consumableId"                           AS "entityId",
  CASE cm."type"
    WHEN 'IN'         THEN 'stock_in'
    WHEN 'OUT'        THEN 'stock_out'
    WHEN 'ADJUSTMENT' THEN 'stock_adjustment'
  END                                         AS "action",
  CASE cm."type"
    WHEN 'IN'         THEN 'Stock added: +'  || cm."quantity"::text
    WHEN 'OUT'        THEN 'Stock removed: -' || cm."quantity"::text
    WHEN 'ADJUSTMENT' THEN 'Stock adjusted to ' || cm."quantity"::text
  END                                         AS "summary"
FROM "consumable_movements" cm
JOIN "consumables" c ON c."id" = cm."consumableId" AND c."deletedAt" IS NULL;
