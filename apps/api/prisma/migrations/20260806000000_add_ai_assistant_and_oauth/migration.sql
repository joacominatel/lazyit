-- AI assistant, MCP server and headless API — the one DDL migration of ADR-0097 (epic #1315, unit W1-A).
-- The consolidated data model is docs/ai-assistant/_synthesis.md §6.
--
-- Additive only (the charter's upgrade-safety rule):
--   - fourteen NEW tables (nine ai_*, five oauth_*), all empty after this runs;
--   - two nullable columns, "aiInvocationId", on asset_history and user_history — ADD COLUMN … NULL with
--     no default, no FK and no index, so existing rows are untouched and the recent_activity view (which
--     selects explicit columns) is unaffected.
-- Nothing is backfilled, renamed or dropped. With no ai_settings row the capability reads as OFF, so an
-- instance that never enables AI behaves exactly as before, and an older app image keeps working against
-- the migrated database (it neither reads nor writes the new tables or columns).
--
-- No data migration for the `ai:use` / `ai:connect` MEMBER defaults: the seed-once ledger (#1314) applies a
-- permission newly added to DEFAULT_ROLE_PERMISSIONS exactly once on the next deploy's seed.
--
-- The core DDL below is `prisma migrate diff`. The raw SQL at the bottom is what Prisma cannot express
-- (docs/05-runbooks/prisma-migrations.md §3): the singleton CHECK, the owner/actor CHECKs, the idempotency
-- partial uniques, and the append-only trigger on ai_action_log.

-- AlterTable
ALTER TABLE "asset_history" ADD COLUMN     "aiInvocationId" TEXT;

-- AlterTable
ALTER TABLE "user_history" ADD COLUMN     "aiInvocationId" TEXT;

-- CreateTable
CREATE TABLE "ai_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "model" TEXT,
    "baseUrl" TEXT,
    "apiKeyCiphertext" TEXT,
    "apiKeyIv" TEXT,
    "apiKeyAuthTag" TEXT,
    "apiKeyKeyVersion" INTEGER,
    "allowPrivateNetwork" BOOLEAN NOT NULL DEFAULT false,
    "effort" TEXT,
    "providerOptions" JSONB,
    "instructions" TEXT,
    "maxStepsPerRun" INTEGER NOT NULL DEFAULT 20,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 16000,
    "contextTokenLimit" INTEGER NOT NULL DEFAULT 150000,
    "dailyTokenLimitPerPrincipal" INTEGER DEFAULT 2000000,
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "approvalTtlMinutes" INTEGER NOT NULL DEFAULT 30,
    "mcpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mcpClientAllowlistAdded" JSONB NOT NULL DEFAULT '[]',
    "mcpClientAllowlistRemovedDefaults" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mcpAllowAnyHttpsClient" BOOLEAN NOT NULL DEFAULT false,
    "disclosureAcknowledgedAt" TIMESTAMP(3),
    "disclosureAcknowledgedById" UUID,
    "verifiedAt" TIMESTAMP(3),
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "userId" UUID,
    "serviceAccountId" TEXT,
    "title" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "toolsetHash" TEXT NOT NULL,
    "toolNames" TEXT[],
    "closedReason" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" BIGSERIAL NOT NULL,
    "conversationId" TEXT NOT NULL,
    "runId" TEXT,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'aisdk-v7',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "channel" TEXT NOT NULL,
    "userId" UUID,
    "serviceAccountId" TEXT,
    "status" TEXT NOT NULL,
    "approvalPolicy" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "finishReason" TEXT,
    "error" JSONB,
    "idempotencyKey" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_invocations" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "conversationId" TEXT,
    "runId" TEXT,
    "toolUseId" TEXT,
    "toolName" TEXT NOT NULL,
    "toolClass" TEXT NOT NULL,
    "userId" UUID,
    "serviceAccountId" TEXT,
    "mcpClientId" TEXT,
    "oauthGrantId" TEXT,
    "input" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "schemaHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "preview" JSONB,
    "precondition" JSONB,
    "expiresAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "result" JSONB,
    "entityRefs" JSONB,
    "errorCode" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_tool_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_action_log" (
    "id" SERIAL NOT NULL,
    "invocationId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolClass" TEXT NOT NULL,
    "userId" UUID,
    "serviceAccountId" TEXT,
    "conversationId" TEXT,
    "runId" TEXT,
    "mcpClientId" TEXT,
    "oauthGrantId" TEXT,
    "input" JSONB,
    "entityRefs" JSONB,
    "approverUserId" UUID,
    "stepUp" BOOLEAN NOT NULL DEFAULT false,
    "untrustedSources" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "requestId" TEXT,
    "errorCode" TEXT,
    "errorStatus" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" BIGSERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" UUID,
    "serviceAccountId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_service_account_settings" (
    "serviceAccountId" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'read-write',
    "maxMutationsPerRun" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_service_account_settings_pkey" PRIMARY KEY ("serviceAccountId")
);

-- CreateTable
CREATE TABLE "ai_config_audit_log" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" UUID,
    "targetServiceAccountId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_config_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientUri" TEXT,
    "logoUri" TEXT,
    "redirectUris" TEXT[],
    "metadata" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_grants" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'oauth',
    "clientRefId" TEXT,
    "label" TEXT,
    "scopes" TEXT[],
    "resource" TEXT NOT NULL,
    "sessionEpoch" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "revokedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "oauth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "clientRefId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "scopes" TEXT[],
    "resource" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_audit_log" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "userId" UUID,
    "actorId" UUID,
    "grantId" TEXT,
    "clientId" TEXT,
    "ip" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_conversations_userId_lastActivityAt_idx" ON "ai_conversations"("userId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "ai_conversations_serviceAccountId_lastActivityAt_idx" ON "ai_conversations"("serviceAccountId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "ai_conversations_lastActivityAt_idx" ON "ai_conversations"("lastActivityAt");

-- CreateIndex
CREATE INDEX "ai_messages_runId_idx" ON "ai_messages"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_conversationId_seq_key" ON "ai_messages"("conversationId", "seq");

-- CreateIndex
CREATE INDEX "ai_runs_status_updatedAt_idx" ON "ai_runs"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_runs_conversationId_idx" ON "ai_runs"("conversationId");

-- CreateIndex
CREATE INDEX "ai_runs_userId_createdAt_idx" ON "ai_runs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_runs_serviceAccountId_createdAt_idx" ON "ai_runs"("serviceAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_tool_invocations_conversationId_createdAt_idx" ON "ai_tool_invocations"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_tool_invocations_runId_idx" ON "ai_tool_invocations"("runId");

-- CreateIndex
CREATE INDEX "ai_tool_invocations_status_expiresAt_idx" ON "ai_tool_invocations"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ai_tool_invocations_createdAt_idx" ON "ai_tool_invocations"("createdAt");

-- CreateIndex
CREATE INDEX "ai_action_log_invocationId_idx" ON "ai_action_log"("invocationId");

-- CreateIndex
CREATE INDEX "ai_action_log_createdAt_idx" ON "ai_action_log"("createdAt");

-- CreateIndex
CREATE INDEX "ai_action_log_userId_id_idx" ON "ai_action_log"("userId", "id");

-- CreateIndex
CREATE INDEX "ai_action_log_serviceAccountId_id_idx" ON "ai_action_log"("serviceAccountId", "id");

-- CreateIndex
CREATE INDEX "ai_usage_userId_createdAt_idx" ON "ai_usage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_serviceAccountId_createdAt_idx" ON "ai_usage"("serviceAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_config_audit_log_createdAt_idx" ON "ai_config_audit_log"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_clientId_key" ON "oauth_clients"("clientId");

-- CreateIndex
CREATE INDEX "oauth_clients_kind_lastUsedAt_idx" ON "oauth_clients"("kind", "lastUsedAt");

-- CreateIndex
CREATE INDEX "oauth_grants_userId_idx" ON "oauth_grants"("userId");

-- CreateIndex
CREATE INDEX "oauth_grants_clientRefId_idx" ON "oauth_grants"("clientRefId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_codeHash_key" ON "oauth_authorization_codes"("codeHash");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_clientRefId_idx" ON "oauth_authorization_codes"("clientRefId");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_expiresAt_idx" ON "oauth_authorization_codes"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_tokenHash_key" ON "oauth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "oauth_tokens_grantId_idx" ON "oauth_tokens"("grantId");

-- CreateIndex
CREATE INDEX "oauth_tokens_expiresAt_idx" ON "oauth_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "oauth_audit_log_userId_createdAt_idx" ON "oauth_audit_log"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "oauth_audit_log_createdAt_idx" ON "oauth_audit_log"("createdAt");

-- AddForeignKey
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_invocations" ADD CONSTRAINT "ai_tool_invocations_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_action_log" ADD CONSTRAINT "ai_action_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_action_log" ADD CONSTRAINT "ai_action_log_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_service_account_settings" ADD CONSTRAINT "ai_service_account_settings_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_config_audit_log" ADD CONSTRAINT "ai_config_audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_clientRefId_fkey" FOREIGN KEY ("clientRefId") REFERENCES "oauth_clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_clientRefId_fkey" FOREIGN KEY ("clientRefId") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "oauth_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- Raw SQL Prisma cannot express
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────

-- Singleton: ai_settings can hold at most one row (the smtp_settings / update_settings precedent). The
-- service upserts by this known id.
ALTER TABLE "ai_settings"
    ADD CONSTRAINT "ai_settings_singleton" CHECK ("id" = 'singleton');

-- A conversation has exactly one owner: a human or a service account (INV-SA-4).
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_exactly_one_owner"
  CHECK ((("userId" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) = 1);

-- A run has exactly one acting principal.
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_exactly_one_principal"
  CHECK ((("userId" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) = 1);

-- A tool invocation and a ledger row carry at most one actor: human XOR service account (the ADR-0048
-- at-most-one-actor CHECKs).
ALTER TABLE "ai_tool_invocations" ADD CONSTRAINT "ai_tool_invocations_one_actor"
  CHECK ((("userId" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);
ALTER TABLE "ai_action_log" ADD CONSTRAINT "ai_action_log_one_actor"
  CHECK ((("userId" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);

-- The headless Idempotency-Key is unique per principal. Two partial unique indexes, one per principal
-- column, so a key never collides across principals and rows without a key are exempt.
CREATE UNIQUE INDEX "ai_runs_user_idempotency_key"
  ON "ai_runs" ("userId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL AND "userId" IS NOT NULL;
CREATE UNIQUE INDEX "ai_runs_service_account_idempotency_key"
  ON "ai_runs" ("serviceAccountId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL AND "serviceAccountId" IS NOT NULL;

-- ai_action_log is the PERMANENT, append-only AI mutation ledger (R6, INV-AI-10). This trigger rejects
-- every DELETE and every UPDATE, so a buggy or compromised application path cannot rewrite or erase it.
--
-- The one UPDATE it lets through is the actor foreign keys' own ON DELETE SET NULL: hard-deleting a user
-- or a service account (lazyit only soft-deletes them, but the FK action must not become an error) nulls
-- "userId" / "serviceAccountId" and changes nothing else. Any other column change is refused. TRUNCATE is
-- not covered: the threat is an application path, not a database administrator (security.md §6.7).
CREATE FUNCTION "ai_action_log_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'userId' - 'serviceAccountId') = (to_jsonb(OLD) - 'userId' - 'serviceAccountId')
     AND (NEW."userId" IS NULL OR NEW."userId" IS NOT DISTINCT FROM OLD."userId")
     AND (NEW."serviceAccountId" IS NULL OR NEW."serviceAccountId" IS NOT DISTINCT FROM OLD."serviceAccountId")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ai_action_log is append-only: % is not allowed', TG_OP
    USING HINT = 'Record a new ledger event instead of changing an existing one.';
END;
$$;

CREATE TRIGGER "ai_action_log_append_only"
  BEFORE UPDATE OR DELETE ON "ai_action_log"
  FOR EACH ROW EXECUTE FUNCTION "ai_action_log_append_only"();
