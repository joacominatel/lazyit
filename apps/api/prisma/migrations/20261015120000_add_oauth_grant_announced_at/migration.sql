-- AUD-014: the first-use MCP notice is decided on "never announced", stored on the grant, instead of on
-- the grant's age. ADDITIVE ONLY: one nullable column, no default, no index.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: a grant whose notice row still exists (dedupe key
-- `mcp.client_connected:<grantId>`) is marked announced at that notice's time. Every other grant reads
-- NULL and is announced on its next /mcp use. A grant whose notice was already pruned by the 90-day
-- retention is therefore announced once more: an extra notice, never a missed one. The API also treats a
-- surviving notice row as announced at read time, which covers notices sent by an older replica.

-- AlterTable
ALTER TABLE "oauth_grants" ADD COLUMN     "announcedAt" TIMESTAMP(3);

-- Backfill from the notices already sent.
UPDATE "oauth_grants" AS g
SET "announcedAt" = n."createdAt"
FROM "notifications" AS n
WHERE n."dedupeKey" = 'mcp.client_connected:' || g."id"
  AND g."announcedAt" IS NULL;
