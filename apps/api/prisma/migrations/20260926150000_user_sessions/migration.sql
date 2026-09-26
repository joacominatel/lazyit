-- Per-device local sessions (issue #1420, ADR-0086 §9 — CEO decisions 2026-09-26). AUTH_MODE=local sign-in
-- now records one `user_sessions` row per device; the token it mints carries the row id as a `sid` claim and
-- the guard refuses a `sid` whose row is gone. `GET /auth/sessions` lists the rows, `DELETE
-- /auth/sessions/:id` ends one and records a SESSION_ENDED user_history row, which this migration also
-- teaches the recent_activity view to summarise. Hand-written view part (Prisma does not track views),
-- mirroring 20260924140000_user_activation_history.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: nothing is rewritten or backfilled.
--   * `user_sessions` is a NEW, EMPTY table. No existing row is touched; the only link to `users` is the new
--     table's own FK (ON DELETE CASCADE, so a hard-deleted user takes their session rows along).
--   * Sessions signed in BEFORE this release have no row and their tokens carry no `sid`: the guard keeps
--     the epoch-only check for them, so NOBODY IS SIGNED OUT by the upgrade (CEO: "siguen vivas"). They end
--     as they always did — at their `exp`, or on any `sessionEpoch` bump (sign out everywhere, password
--     change, admin reset, deactivation, offboarding). They are not listed individually.
--   * `ADD VALUE` appends to the enum type (O(1), no table rewrite). It is not USED as an enum literal in
--     this transaction (the view matches `eventType::text`), so there is no 55P04.
--   * The view keeps its exact column list, order and names — only one summary branch is added.
--   * Rolling the API back: the older guard ignores the unknown `sid` claim, so new tokens keep working
--     under the epoch-only check; the table is simply unused.
--   * ROLLBACK CAVEAT: ending ONE session only deletes its row. After a rollback to a pre-#1420 API those
--     tokens are accepted again (the old guard never reads this table) until their `exp` — or forever for
--     a remember-me token. After a rollback, have affected users "sign out everywhere" (or change their
--     password / have an admin reset or deactivate them): an epoch bump ends every token on any version.

-- AlterEnum
ALTER TYPE "UserHistoryEventType" ADD VALUE 'SESSION_ENDED';

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,
    "rememberMe" BOOLEAN NOT NULL DEFAULT false,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_sessions_userId_idx" ON "user_sessions"("userId");

-- CreateIndex
CREATE INDEX "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- recent_activity view (ADR-0050): CREATE OR REPLACE to add the SESSION_ENDED summary branch to the
-- UserHistory source. Every other branch is byte-identical to the previous definition
-- (20260924140000_user_activation_history).
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

-- 5) UserHistory — user lifecycle events (DEBT-2, issue #185 / ADR-0058 / ADR-0086 §5 + §F4 + §9 / issues #1375, #1420).
--    entityType = 'user'. The SUBJECT user is both the affected entity and the target person. The summary
--    CASE switches on eventType::text (see the note above) and carries the DEACTIVATED / REACTIVATED
--    activation branches and the SESSION_ENDED branch (#1420). A deactivated user is NOT soft-deleted, so the live-subject join keeps the row.
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
    WHEN 'SESSION_ENDED'            THEN 'Session ended'
  END                                         AS "summary",
  u."firstName" || ' ' || u."lastName"        AS "subjectName",
  u."id"                                      AS "targetUserId",
  u."firstName" || ' ' || u."lastName"        AS "targetUserName"
FROM "user_history" uh
JOIN "users" u ON u."id" = uh."userId" AND u."deletedAt" IS NULL;
