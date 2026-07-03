-- Local (first-party) password LIFECYCLE — ADR-0086 §F4 (F4a, issue #1003). Self-service change,
-- forgot-password (email token) and reset-password. Generated OFFLINE via `prisma migrate diff`
-- (schema-to-schema, NO database connection); the recent_activity view CREATE OR REPLACE is appended by
-- hand (Prisma does not track views), mirroring the 20260703010000_local_auth_provisioning precedent.

-- AlterEnum: two self-service verbs join UserHistoryEventType. PASSWORD_CHANGED — the user changed their
-- OWN password (actor == subject). PASSWORD_RESET_COMPLETED — the user reset it themselves via a
-- forgot-password email token (distinct from PASSWORD_RESET_BY_ADMIN, where an admin acted). Lowercased,
-- these are the `password_changed` / `password_reset_completed` verbs the recent_activity view emits
-- (added to RECENT_ACTIVITY_ACTIONS). PG12+ permits multiple ADD VALUEs in one transaction as long as the
-- new values are not USED as an enum literal in the same tx — the view below matches them as TEXT (::text).
ALTER TYPE "UserHistoryEventType" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "UserHistoryEventType" ADD VALUE 'PASSWORD_RESET_COMPLETED';

-- CreateTable: password_reset_tokens (ADR-0086 §F4 / SECURITY GAP #7). Single-use, short-TTL, bound to a
-- user. The RAW token is NEVER stored — only `tokenHash` = SHA-256(raw) (hash-at-rest, the SA-token mold).
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique tokenHash = the reset point-read + replay guard.
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex: userId powers sibling-invalidation + per-user prune.
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex: expiresAt powers the opportunistic GC sweep of stale tokens.
CREATE INDEX "password_reset_tokens_expiresAt_idx" ON "password_reset_tokens"("expiresAt");

-- AddForeignKey: Cascade on the (rare) hard delete of a user drops their tokens.
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- recent_activity view (ADR-0050 / ADR-0086 §F4): CREATE OR REPLACE to add the PASSWORD_CHANGED and
-- PASSWORD_RESET_COMPLETED summary branches to the UserHistory source. Postgres requires the existing
-- column list/order/names to stay byte-identical and only NEW columns at the tail — none change here. The
-- summary CASE switches on `eventType::text` (NOT the bare enum) so the freshly-added values are matched as
-- TEXT and never trip "unsafe use of new enum value" (55P04) in the same transaction as the ADD VALUEs
-- above (the local_auth_provisioning / user_manager_clone pattern).
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

-- 5) UserHistory — user lifecycle events (DEBT-2, issue #185 / ADR-0058 / ADR-0086 §5 + §F4). entityType =
--    'user'. The SUBJECT user is both the affected entity and the target person. The summary CASE switches
--    on eventType::text (see the note above) and now carries the self-service PASSWORD_CHANGED and
--    PASSWORD_RESET_COMPLETED branches alongside PASSWORD_RESET_BY_ADMIN.
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
    WHEN 'PASSWORD_RESET_COMPLETED' THEN 'Password reset completed'
  END                                         AS "summary",
  u."firstName" || ' ' || u."lastName"        AS "subjectName",
  u."id"                                      AS "targetUserId",
  u."firstName" || ' ' || u."lastName"        AS "targetUserName"
FROM "user_history" uh
JOIN "users" u ON u."id" = uh."userId" AND u."deletedAt" IS NULL;
