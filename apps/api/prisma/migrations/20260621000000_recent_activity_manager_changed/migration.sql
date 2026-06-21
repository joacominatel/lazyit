-- recent_activity view — confirm the MANAGER_CHANGED summary branch (issue #618).
--
-- The MANAGER_CHANGED UserHistoryEventType verb was added to the `user_history` enum in
-- 20260611180848_user_manager_clone and the view was updated in the same migration. However
-- the migration comment that shipped with that change was buried in a large multi-purpose
-- migration (manager self-relation, legajo/username, partial uniques, CHECKs AND the view fix),
-- making it hard to trace "what fixed the blank summary for manager_changed?". This migration
-- is the canonical fix point for #618: it re-states the full view as a CREATE OR REPLACE VIEW
-- so the migration history has a clear, searchable anchor for this defect.
--
-- The SQL is a verbatim copy of the final view from 20260611180848 — the MANAGER_CHANGED branch
-- is already in the live view, so this is a safe no-op replay. Postgres CREATE OR REPLACE VIEW
-- replaces the view definition in-place with no DROP required and no column-list change, so
-- this is non-destructive. It also catches any DB that missed the earlier migration's view
-- update (e.g. a production instance that applied the migration but the view replacement
-- silently failed during a transaction rollback for an unrelated reason).
--
-- The companion unit test (dashboard.service.spec.ts, "view summary coverage") extracts and
-- asserts every UserHistoryEventType value has a non-NULL summary branch, so the next ADD VALUE
-- automatically breaks the test until the view is also updated.

CREATE OR REPLACE VIEW "recent_activity" AS
-- 1) AssetHistory — discrete asset state changes (ADR-0033). entityType = 'asset'.
SELECT
  ah."createdAt"::timestamptz                 AS "occurredAt",
  ah."performedById"                          AS "actorId",
  'asset'                                     AS "entityType",
  ah."assetId"                                AS "entityId",
  lower(ah."eventType"::text)                 AS "action",
  'Asset ' || lower(replace(ah."eventType"::text, '_', ' ')) AS "summary",
  a."name"                                    AS "subjectName",
  NULL::uuid                                  AS "targetUserId",
  NULL::text                                  AS "targetUserName"
FROM "asset_history" ah
JOIN "assets" a ON a."id" = ah."assetId" AND a."deletedAt" IS NULL

UNION ALL

-- 2) AssetAssignment — ownership opened (assigned). entityType = 'asset'.
SELECT
  aa."assignedAt"::timestamptz                AS "occurredAt",
  aa."assignedById"                           AS "actorId",
  'asset'                                     AS "entityType",
  aa."assetId"                                AS "entityId",
  'assigned'                                  AS "action",
  'Asset assigned to a user'                  AS "summary",
  a."name"                                    AS "subjectName",
  tu."id"                                     AS "targetUserId",
  CASE WHEN tu."id" IS NULL THEN NULL ELSE tu."firstName" || ' ' || tu."lastName" END AS "targetUserName"
FROM "asset_assignments" aa
JOIN "assets" a ON a."id" = aa."assetId" AND a."deletedAt" IS NULL
LEFT JOIN "users" tu ON tu."id" = aa."userId" AND tu."deletedAt" IS NULL

UNION ALL

-- 2b) AssetAssignment — ownership closed (released).
SELECT
  aa."releasedAt"::timestamptz                AS "occurredAt",
  aa."releasedById"                           AS "actorId",
  'asset'                                     AS "entityType",
  aa."assetId"                                AS "entityId",
  'released'                                  AS "action",
  'Asset released from a user'                AS "summary",
  a."name"                                    AS "subjectName",
  tu."id"                                     AS "targetUserId",
  CASE WHEN tu."id" IS NULL THEN NULL ELSE tu."firstName" || ' ' || tu."lastName" END AS "targetUserName"
FROM "asset_assignments" aa
JOIN "assets" a ON a."id" = aa."assetId" AND a."deletedAt" IS NULL
LEFT JOIN "users" tu ON tu."id" = aa."userId" AND tu."deletedAt" IS NULL
WHERE aa."releasedAt" IS NOT NULL

UNION ALL

-- 3) AccessGrant — access opened (granted). entityType = 'application'.
SELECT
  ag."grantedAt"::timestamptz                 AS "occurredAt",
  ag."grantedById"                            AS "actorId",
  'application'                               AS "entityType",
  ag."applicationId"                          AS "entityId",
  'granted'                                   AS "action",
  'Access granted to a user'                  AS "summary",
  ap."name"                                   AS "subjectName",
  tu."id"                                     AS "targetUserId",
  CASE WHEN tu."id" IS NULL THEN NULL ELSE tu."firstName" || ' ' || tu."lastName" END AS "targetUserName"
FROM "access_grants" ag
JOIN "applications" ap ON ap."id" = ag."applicationId" AND ap."deletedAt" IS NULL
LEFT JOIN "users" tu ON tu."id" = ag."userId" AND tu."deletedAt" IS NULL

UNION ALL

-- 3b) AccessGrant — access closed (revoked).
SELECT
  ag."revokedAt"::timestamptz                 AS "occurredAt",
  ag."revokedById"                            AS "actorId",
  'application'                               AS "entityType",
  ag."applicationId"                          AS "entityId",
  'revoked'                                   AS "action",
  'Access revoked from a user'                AS "summary",
  ap."name"                                   AS "subjectName",
  tu."id"                                     AS "targetUserId",
  CASE WHEN tu."id" IS NULL THEN NULL ELSE tu."firstName" || ' ' || tu."lastName" END AS "targetUserName"
FROM "access_grants" ag
JOIN "applications" ap ON ap."id" = ag."applicationId" AND ap."deletedAt" IS NULL
LEFT JOIN "users" tu ON tu."id" = ag."userId" AND tu."deletedAt" IS NULL
WHERE ag."revokedAt" IS NOT NULL

UNION ALL

-- 4) ConsumableMovement — stock ledger entries (ADR-0034). entityType = 'consumable'.
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
  END                                         AS "summary",
  c."name"                                    AS "subjectName",
  NULL::uuid                                  AS "targetUserId",
  NULL::text                                  AS "targetUserName"
FROM "consumable_movements" cm
JOIN "consumables" c ON c."id" = cm."consumableId" AND c."deletedAt" IS NULL

UNION ALL

-- 5) UserHistory — user lifecycle events (DEBT-2, issue #185 / ADR-0058). entityType = 'user'. The
--    SUBJECT user is both the affected entity and the target person. The summary CASE switches on
--    eventType::text so the MANAGER_CHANGED label is matched as TEXT and never trips the "unsafe use
--    of new enum value" error (55P04) when this runs in the same transaction as the ADD VALUE.
SELECT
  uh."createdAt"::timestamptz                 AS "occurredAt",
  uh."performedById"                          AS "actorId",
  'user'                                      AS "entityType",
  uh."userId"::text                           AS "entityId",
  lower(uh."eventType"::text)                 AS "action",
  CASE uh."eventType"::text
    WHEN 'CREATED'             THEN 'User created'
    WHEN 'UPDATED'             THEN 'User profile updated'
    WHEN 'ROLE_CHANGED'        THEN 'User role changed'
    WHEN 'MANAGER_CHANGED'     THEN 'User manager changed'
    WHEN 'DELETED'             THEN 'User offboarded'
    WHEN 'RESTORED'            THEN 'User restored'
    WHEN 'PASSWORD_RESET_SENT' THEN 'Password reset sent'
  END                                         AS "summary",
  u."firstName" || ' ' || u."lastName"        AS "subjectName",
  u."id"                                      AS "targetUserId",
  u."firstName" || ' ' || u."lastName"        AS "targetUserName"
FROM "user_history" uh
JOIN "users" u ON u."id" = uh."userId" AND u."deletedAt" IS NULL;
