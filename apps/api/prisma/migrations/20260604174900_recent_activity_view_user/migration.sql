-- Recent activity feed — add the FIFTH source (DEBT-2, issue #185): UserHistory. CREATE OR REPLACE the
-- recent_activity view to UNION ALL a `user_history` branch that maps a user lifecycle event to a feed
-- row with entityType 'user'. This is the contract-widening counterpart of the new UserHistory model:
-- the dashboard activity stream now surfaces who provisioned / edited / role-changed / offboarded /
-- restored / triggered a password reset for each user. See ADR-0050 (links ADR-0044 / ADR-0033 / ADR-0006).
--
-- CREATE OR REPLACE keeps the EXACT same column list, order and names as the original view
-- (20260601163936_recent_activity_view) — Postgres requires that for a replace; only a new UNION branch
-- is appended. The view stays a DERIVED read model: Prisma neither tracks nor flags it as drift, and the
-- typed $queryRaw in DashboardService reads it unchanged.
--
-- The new branch mirrors the others:
--   occurredAt = uh.createdAt (append-only timestamp)
--   actorId    = uh.performedById (the HUMAN actor; a service-account-authored row has performedById NULL,
--                so actorId is NULL — honest: the view's actorId column joins to `users`, never to
--                service_accounts, exactly like every other branch's *ById column)
--   entityType = 'user'
--   entityId   = uh.userId::text (the view's entityId column is text; cast the uuid like the others stay text)
--   action     = lower(eventType) → created · updated · role_changed · deleted · restored · password_reset_sent
--   summary    = a terse, human-readable line ("User created", "User role changed", …)
-- Soft delete (ADR-0032): join to `users` and keep only LIVE subjects (deletedAt IS NULL) — a
-- soft-deleted (offboarded) user drops out of the feed, matching every other branch. (A user's own
-- DELETED event therefore disappears the moment it is recorded — consistent with how a soft-deleted
-- asset's history rows drop out; the offboarding still shows via the released/revoked branches.)

CREATE OR REPLACE VIEW "recent_activity" AS
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
JOIN "consumables" c ON c."id" = cm."consumableId" AND c."deletedAt" IS NULL

UNION ALL

-- 5) UserHistory — user lifecycle events (DEBT-2, issue #185). entityType = 'user'. The event verb is
--    lowercased; entityId is the SUBJECT user's id (cast to text). actorId = performedById (the human
--    actor; NULL for a service-account-authored or system row, honest — the view never joins
--    actorId to service_accounts). Only LIVE subjects (the user's deletedAt IS NULL) are kept.
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
  END                                         AS "summary"
FROM "user_history" uh
JOIN "users" u ON u."id" = uh."userId" AND u."deletedAt" IS NULL;
