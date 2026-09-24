-- ADR-0097 decision 8 (amended 2026-09-24, CEO decision, issue #1315): MCP credentials (OAuth grants and
-- personal MCP tokens) get their own revocation counter, so a normal web logout — which bumps only
-- `sessionEpoch` — no longer kills them. Additive: two NOT NULL columns, both filled for existing rows.

-- AlterTable: the per-user counter. Existing users start at 0.
ALTER TABLE "users" ADD COLUMN "mcpCredentialEpoch" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: each grant's snapshot of it. The temporary DEFAULT 0 fills existing grants; it is dropped
-- below, so every new grant must state its snapshot explicitly (as `sessionEpoch` already does).
ALTER TABLE "oauth_grants" ADD COLUMN "mcpCredentialEpoch" INTEGER NOT NULL DEFAULT 0;

-- One-time data step: preserve each existing grant's liveness exactly. A grant whose `sessionEpoch`
-- snapshot still matches its user's was alive before this migration and keeps 0 (= the user's new 0);
-- one that no longer matches was already dead and gets -1, which never matches (the counter only grows).
UPDATE "oauth_grants" AS g
SET "mcpCredentialEpoch" = -1
FROM "users" AS u
WHERE g."userId" = u."id" AND g."sessionEpoch" <> u."sessionEpoch";

ALTER TABLE "oauth_grants" ALTER COLUMN "mcpCredentialEpoch" DROP DEFAULT;
