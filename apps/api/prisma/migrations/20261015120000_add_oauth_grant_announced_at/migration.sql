-- AUD-014: the first-use MCP notice is decided on "never announced", stored on the grant, instead of on
-- the grant's age. ADDITIVE ONLY: one nullable column, no default, no index.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: a grant whose notice row still exists (dedupe key
-- `mcp.client_connected:<grantId>`) is marked announced at that notice's time, so it is never announced
-- again. Every other grant reads NULL and is announced on its next /mcp use. The notice shipped with /mcp
-- itself less than 90 days ago, so no notice has been pruned yet and every connection already used has
-- its row; the API also treats a surviving notice row as announced at read time.

-- AlterTable
ALTER TABLE "oauth_grants" ADD COLUMN     "announcedAt" TIMESTAMP(3);

-- Backfill from the notices already sent.
UPDATE "oauth_grants" AS g
SET "announcedAt" = n."createdAt"
FROM "notifications" AS n
WHERE n."dedupeKey" = 'mcp.client_connected:' || g."id"
  AND g."announcedAt" IS NULL;
