-- User activation audit (issue #1375). Deactivating or reactivating a user (PATCH /users/:id with a real
-- isActive flip — from the web UI, the API or an AI tool call, which dispatches to the same route) wrote
-- NO user_history row, so the change never reached the recent_activity view and Reports → Users. The
-- service now records DEACTIVATED / REACTIVATED; this migration adds the two enum values and the matching
-- summary branches to the view. Hand-written (Prisma does not track views), mirroring the
-- 20260703030000_password_reset_requested precedent.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: nothing is rewritten or backfilled. `ADD VALUE` appends to the
-- type (O(1), no table rewrite). Activation changes made BEFORE this release left no row and stay absent
-- (there is no trustworthy source to backfill them from); every change after it is recorded. The view
-- keeps its exact column list, order and names — only two summary branches are added.

-- AlterEnum: appended at the tail here and in the PSL enum, so the two orders stay in step. Neither value
-- is USED as an enum literal in this transaction (the view below matches `eventType::text`), so there is
-- no 55P04 "unsafe use of new enum value".
ALTER TYPE "UserHistoryEventType" ADD VALUE 'DEACTIVATED';
ALTER TYPE "UserHistoryEventType" ADD VALUE 'REACTIVATED';

-- recent_activity view (ADR-0050): CREATE OR REPLACE to add the DEACTIVATED / REACTIVATED summary
-- branches to the UserHistory source. Every other branch is byte-identical to the previous definition.
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

-- 2b) AssetAssignment — ownership closed (released). Only rows that have actually been released.
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

-- 3b) AccessGrant — access closed (revoked). Only rows that have actually been revoked.
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

-- 5) UserHistory — user lifecycle events (DEBT-2, issue #185 / ADR-0058 / ADR-0086 §5 + §F4 / issue #1375).
--    entityType = 'user'. The SUBJECT user is both the affected entity and the target person. The summary
--    CASE switches on eventType::text (see the note above) and now carries the DEACTIVATED / REACTIVATED
--    activation branches. A deactivated user is NOT soft-deleted, so the live-subject join keeps the row.
SELECT
  uh."createdAt"::timestamptz                 AS "occurredAt",
  uh."performedById"                          AS "actorId",
  'user'                                      AS "entityType",
  uh."userId"::text                           AS "entityId",
  lower(uh."eventType"::text)                 AS "action",
  CASE uh."eventType"::text
    WHEN 'CREATED'                  THEN 'User created'
    WHEN 'UPDATED'                  THEN 'User profile updated'
    WHEN 'ROLE_CHANGED'             THEN 'User role changed'
    WHEN 'MANAGER_CHANGED'          THEN 'User manager changed'
    WHEN 'DELETED'                  THEN 'User offboarded'
    WHEN 'RESTORED'                 THEN 'User restored'
    WHEN 'PASSWORD_RESET_SENT'      THEN 'Password reset sent'
    WHEN 'PASSWORD_RESET_BY_ADMIN'  THEN 'Password reset by admin'
    WHEN 'PASSWORD_CHANGED'         THEN 'Password changed'
    WHEN 'PASSWORD_RESET_REQUESTED' THEN 'Password reset requested'
    WHEN 'PASSWORD_RESET_COMPLETED' THEN 'Password reset completed'
    WHEN 'DEACTIVATED'              THEN 'User deactivated'
    WHEN 'REACTIVATED'              THEN 'User reactivated'
  END                                         AS "summary",
  u."firstName" || ' ' || u."lastName"        AS "subjectName",
  u."id"                                      AS "targetUserId",
  u."firstName" || ' ' || u."lastName"        AS "targetUserName"
FROM "user_history" uh
JOIN "users" u ON u."id" = uh."userId" AND u."deletedAt" IS NULL;
