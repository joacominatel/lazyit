-- Server-driven reporting-agent policy (ADR-0074 §7 amendment, issue #1140). ADDITIVE + nullable/
-- defaulted ONLY (STANDING RULE #8, upgrade-safe over live data): four nullable columns on
-- `infra_nodes`, one nullable column on `service_accounts`, and a new singleton config table. No
-- backfill is needed or shipped — every existing row reads NULL, which resolves to "adds no override"
-- and therefore to exactly the pre-#1140 agent behaviour. The singleton-id CHECK is raw SQL Prisma
-- cannot express in PSL, mirroring the SmtpSettings/UpdateSettings/DirectoryConnection precedent.

-- AlterTable: the NARROWEST policy scope (a per-node override) plus the acknowledgement pair and the
-- denormalized staleness threshold the §4 sweeper judges this node against.
ALTER TABLE "infra_nodes" ADD COLUMN     "agentPolicy" JSONB,
ADD COLUMN     "policyAppliedAt" TIMESTAMP(3),
ADD COLUMN     "policyRevision" INTEGER,
ADD COLUMN     "policyStaleAfterSeconds" INTEGER;

-- AlterTable: the MIDDLE policy scope — the natural anchor before a node exists, since the "Add a
-- server" wizard mints one service account per agent.
ALTER TABLE "service_accounts" ADD COLUMN     "agentPolicy" JSONB;

-- CreateTable: the singleton instance-default row + the instance-wide policy revision counter.
CREATE TABLE "agent_policy_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_policy_settings_pkey" PRIMARY KEY ("id")
);

-- Singleton CHECK: the table can hold AT MOST one row, so a second insert is structurally impossible
-- rather than merely discouraged (the SmtpSettings/UpdateSettings pattern).
ALTER TABLE "agent_policy_settings"
  ADD CONSTRAINT "agent_policy_settings_singleton_id_check" CHECK ("id" = 'singleton');
