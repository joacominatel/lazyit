-- User identity graph (ADR-0058): legajo / username + the manager self-relation (link XOR free-text),
-- plus the MANAGER_CHANGED UserHistory verb. The column adds, the self-FK and the new enum value are
-- Prisma-generated; the pieces Prisma cannot express in PSL — two LIVE-only partial unique indexes and
-- the two manager CHECKs — are appended as raw SQL at the bottom, mirroring the email partial-unique
-- precedent (20260601130000) and the at-most-one-actor CHECKs (20260602232921 / 20260604174820).

-- AlterEnum
ALTER TYPE "UserHistoryEventType" ADD VALUE 'MANAGER_CHANGED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "legajo" TEXT,
ADD COLUMN     "managerId" UUID,
ADD COLUMN     "managerName" TEXT,
ADD COLUMN     "username" TEXT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- RAW SQL Prisma cannot represent (it neither emits nor reports these on `migrate diff`, so the drift
-- check stays green). See docs/05-runbooks/prisma-migrations.md §3 and ADR-0058.
-- ---------------------------------------------------------------------------------------------------

-- Partial UNIQUE indexes (ADR-0041 / ADR-0058) — `legajo` / `username` are unique among LIVE rows only
-- (`"deletedAt" IS NULL`), so a soft-deleted (offboarded) user frees the value for reuse and a Restore
-- can reclaim it. NULLs are distinct in Postgres, so an absent legajo/username never collides. Index
-- names mirror the email `_active_key` style.

-- CreateIndex
CREATE UNIQUE INDEX "users_legajo_active_key"
    ON "users"("legajo")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_username_active_key"
    ON "users"("username")
    WHERE "deletedAt" IS NULL;

-- MANAGER at-most-one (ADR-0058): a manager is EITHER a lazyit user (managerId) OR a free-text name
-- (managerName), never both. Both-null is legal ("no manager recorded"). Mirrors the at-most-one-actor
-- CHECKs (ADR-0048). The wire contract carries the same invariant as a discriminated input union.
ALTER TABLE "users" ADD CONSTRAINT "users_manager_at_most_one"
  CHECK ((("managerId" IS NOT NULL)::int + ("managerName" IS NOT NULL)::int) <= 1);

-- MANAGER not-self (ADR-0058): a user can never be their own manager. The DB backstops the service's
-- self-manager + cycle rejection (the service rejects a cycle via DFS up the chain; this CHECK covers
-- the degenerate one-node cycle so it can never be written even by a raw path).
ALTER TABLE "users" ADD CONSTRAINT "users_manager_not_self"
  CHECK ("managerId" IS NULL OR "managerId" <> "id");

-- recent_activity view (ADR-0050 / ADR-0058): CREATE OR REPLACE to add the MANAGER_CHANGED summary
-- branch to the UserHistory source so a manager change reads as "User manager changed" in the feed
-- (the action verb is the lowercased eventType → `manager_changed`, added to RECENT_ACTIVITY_ACTIONS).
-- Postgres requires the existing column list/order/names to stay byte-identical and only NEW columns at
-- the tail — none change here. The summary CASE is rewritten to switch on `eventType::text` (not the
-- bare enum) so the freshly-added 'MANAGER_CHANGED' label is matched as TEXT and never trips the
-- "unsafe use of new enum value" error (55P04) when this runs in the same transaction as the ADD VALUE.
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
--    eventType::text (see the note above) and now carries the MANAGER_CHANGED branch.
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
