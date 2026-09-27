-- Per-conversation AI settings (#1373 model and reasoning, #1376 auto-approve; ADR-0097 amended
-- 2026-09-24). Additive only: every new column is nullable or has a default, nothing is backfilled.
-- Existing conversations read as "instance default model, instance effort/options, auto-approve off" —
-- exactly how they behave today. Existing ledger and invocation rows keep a null approval mode.
-- Adding a column fires no row trigger, so the ai_action_log append-only trigger is not involved.

-- AlterTable
ALTER TABLE "ai_conversations"
  ADD COLUMN "modelChosen" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "effort" TEXT,
  ADD COLUMN "providerOptions" JSONB,
  ADD COLUMN "autoApprove" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoApproveEnabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ai_tool_invocations" ADD COLUMN "approvalMode" TEXT;

-- AlterTable
ALTER TABLE "ai_action_log"
  ADD COLUMN "approvalMode" TEXT,
  ADD COLUMN "autoApproveEnabledAt" TIMESTAMP(3);
