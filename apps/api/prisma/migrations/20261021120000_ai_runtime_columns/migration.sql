-- AI runtime state as columns (#1675, split from #1344; ADR-0097 "Deferred"). Additive only: two
-- nullable columns, metadata-only in PostgreSQL (no rewrite, no index), no backfill.
--
-- New conversations store their frozen system prompt in ai_conversations."systemPrompt", and new runs
-- their chat session epoch in ai_runs."sessionEpoch", instead of the `lazyit-system-prompt-v1` and
-- `lazyit-run-v1` rows in ai_messages. Every existing conversation and run reads NULL and the runtime
-- falls back to those legacy rows, which stay where they are (append-only; they go with their
-- conversation as before).

ALTER TABLE "ai_conversations" ADD COLUMN "systemPrompt" TEXT;

ALTER TABLE "ai_runs" ADD COLUMN "sessionEpoch" INTEGER;
