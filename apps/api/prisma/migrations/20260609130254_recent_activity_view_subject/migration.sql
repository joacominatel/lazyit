-- Recent activity feed — SUBJECT enrichment (issue #311, epic #157 / Informes). CREATE OR REPLACE the
-- recent_activity view to APPEND three resolved-subject columns so each feed row names WHICH entity
-- (and, where the event concerns a person, WHICH user) it is about — turning the generic "Access
-- revoked from a user" line into a specific, click-through "Access to <App> revoked from <User>".
--
-- The three new columns (appended at the END — Postgres CREATE OR REPLACE VIEW requires the existing
-- column list, order and names to stay byte-identical and only permits NEW columns at the tail):
--   subjectName    text  — the AFFECTED entity's display name (Application.name / Asset.name /
--                          Consumable.name / the subject user's "firstName lastName"). Pairs with the
--                          existing entityType + entityId for the primary click-through.
--   targetUserId   uuid  — the user the event is ABOUT (the grant holder / assignment owner / the
--                          user-history subject), DISTINCT from actorId (who DID it). NULL for events
--                          with no person subject (asset state changes, consumable movements).
--   targetUserName text  — that target user's display name, or NULL.
--
-- Every new column is NULLABLE and additive — a source with no subject (or an unresolved relation)
-- yields NULL, and the web falls back to the existing `summary`. Nothing else about the view changes:
-- the same five UNION ALL branches, the same parent soft-delete joins, the same first six columns in
-- the same order. The view stays a DERIVED read model (Prisma does not track it). The typed $queryRaw
-- in DashboardService is widened in the same change to SELECT the three new columns.
--
-- Soft delete (ADR-0032): the TARGET user is LEFT-JOINed on `deletedAt IS NULL`, so a soft-deleted
-- (offboarded) target resolves its name/id to NULL — the row still appears via its LIVE parent
-- (the app/asset is not soft-deleted), but we never surface a soft-deleted person's name. The
-- visibility scope of the feed itself is unchanged (the endpoint stays gated on logs:read).

CREATE OR REPLACE VIEW "recent_activity" AS
-- 1) AssetHistory — discrete asset state changes (ADR-0033). entityType = 'asset'. subjectName = the
--    asset's name. No person subject for a state change, so targetUser* are NULL.
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

-- 2) AssetAssignment — ownership opened (assigned). entityType = 'asset'. subjectName = the asset's
--    name; the target user is the assignment OWNER (aa.userId).
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

-- 3) AccessGrant — access opened (granted). entityType = 'application'. subjectName = the application's
--    name; the target user is the grant HOLDER (ag.userId).
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

-- 4) ConsumableMovement — stock ledger entries (ADR-0034). entityType = 'consumable'. subjectName = the
--    consumable's name. No person subject for a movement, so targetUser* are NULL.
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

-- 5) UserHistory — user lifecycle events (DEBT-2, issue #185). entityType = 'user'. The SUBJECT user is
--    both the affected entity and the target person, so subjectName = targetUserName = the subject's
--    name, and targetUserId = the subject's id (the view already keeps only LIVE subjects).
SELECT
  uh."createdAt"::timestamptz                 AS "occurredAt",
  uh."performedById"                          AS "actorId",
  'user'                                      AS "entityType",
  uh."userId"::text                           AS "entityId",
  lower(uh."eventType"::text)                 AS "action",
  CASE uh."eventType"
    WHEN 'CREATED'             THEN 'User created'
    WHEN 'UPDATED'             THEN 'User profile updated'
    WHEN 'ROLE_CHANGED'        THEN 'User role changed'
    WHEN 'DELETED'             THEN 'User offboarded'
    WHEN 'RESTORED'            THEN 'User restored'
    WHEN 'PASSWORD_RESET_SENT' THEN 'Password reset sent'
  END                                         AS "summary",
  u."firstName" || ' ' || u."lastName"        AS "subjectName",
  u."id"                                      AS "targetUserId",
  u."firstName" || ' ' || u."lastName"        AS "targetUserName"
FROM "user_history" uh
JOIN "users" u ON u."id" = uh."userId" AND u."deletedAt" IS NULL;
