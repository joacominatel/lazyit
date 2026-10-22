-- OAuth authorization codes (#1683, split from #1344): two additive, nullable columns, no backfill.
--   "mcpCredentialEpoch": the user's MCP credential epoch at consent; the code exchange is refused when it
--     moved. Codes issued before this migration read null and skip the check until they expire (60 s).
--   "grantId": the grant a code produced, set when it is redeemed; a replayed code revokes that grant.
--     Null for codes not yet redeemed, burned by a failed exchange, or issued before this migration.
-- Codes are short-lived protocol state (hard-deleted by the OAuth sweeper), so existing rows need nothing.
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "mcpCredentialEpoch" INTEGER,
ADD COLUMN "grantId" TEXT;

CREATE UNIQUE INDEX "oauth_authorization_codes_grantId_key" ON "oauth_authorization_codes"("grantId");

ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "oauth_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
