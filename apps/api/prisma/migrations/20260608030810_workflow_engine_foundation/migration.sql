-- CreateEnum
CREATE TYPE "WorkflowTrigger" AS ENUM ('ACCESS_GRANTED', 'ACCESS_REVOKED', 'TIMER_AFTER_GRANT', 'SCHEDULED', 'RECERTIFICATION');

-- CreateEnum
CREATE TYPE "WorkflowDeprovisionPolicy" AS ENUM ('LAST_ACTIVE_GRANT', 'EACH_GRANT');

-- CreateEnum
CREATE TYPE "WorkflowConnectionKind" AS ENUM ('REST', 'WEBHOOK_OUT', 'MANUAL', 'SDK', 'MCP', 'PREBUILT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'SUCCEEDED', 'FAILED', 'COMPENSATED');

-- CreateEnum
CREATE TYPE "WorkflowStepRunStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'AWAITING_INPUT', 'SKIPPED', 'COMPENSATED');

-- CreateEnum
CREATE TYPE "ManualTaskStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "application_workflows" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "trigger" "WorkflowTrigger" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "deprovisionPolicy" "WorkflowDeprovisionPolicy" NOT NULL DEFAULT 'LAST_ACTIVE_GRANT',
    "executedAsServiceAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "application_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_connections" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" "WorkflowConnectionKind" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "secretId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" SERIAL NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "steps" JSONB NOT NULL,
    "createdById" UUID,
    "createdBySaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowVersionId" INTEGER NOT NULL,
    "applicationId" TEXT NOT NULL,
    "trigger" "WorkflowTrigger" NOT NULL,
    "accessGrantId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
    "triggeredById" UUID,
    "triggeredBySaId" TEXT,
    "executedAsServiceAccountId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_step_runs" (
    "id" SERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "stepKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "WorkflowStepRunStatus" NOT NULL,
    "externalCorrelationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_tasks" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "assigneeId" UUID,
    "cohort" TEXT,
    "prompt" TEXT NOT NULL,
    "input" JSONB,
    "status" "ManualTaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedById" UUID,
    "completedBySaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_secrets" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "connectionId" TEXT,
    "label" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_workflows_applicationId_idx" ON "application_workflows"("applicationId");

-- CreateIndex
CREATE INDEX "application_workflows_executedAsServiceAccountId_idx" ON "application_workflows"("executedAsServiceAccountId");

-- CreateIndex
CREATE INDEX "workflow_connections_applicationId_idx" ON "workflow_connections"("applicationId");

-- CreateIndex
CREATE INDEX "workflow_connections_secretId_idx" ON "workflow_connections"("secretId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflowId_version_key" ON "workflow_versions"("workflowId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_idempotencyKey_key" ON "workflow_runs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "workflow_runs_applicationId_idx" ON "workflow_runs"("applicationId");

-- CreateIndex
CREATE INDEX "workflow_runs_workflowId_idx" ON "workflow_runs"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_runs_accessGrantId_idx" ON "workflow_runs"("accessGrantId");

-- CreateIndex
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs"("status");

-- CreateIndex
CREATE INDEX "workflow_step_runs_runId_id_idx" ON "workflow_step_runs"("runId", "id");

-- CreateIndex
CREATE INDEX "manual_tasks_runId_idx" ON "manual_tasks"("runId");

-- CreateIndex
CREATE INDEX "manual_tasks_assigneeId_status_idx" ON "manual_tasks"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "manual_tasks_status_idx" ON "manual_tasks"("status");

-- CreateIndex
CREATE INDEX "workflow_secrets_applicationId_idx" ON "workflow_secrets"("applicationId");

-- CreateIndex
CREATE INDEX "workflow_secrets_connectionId_idx" ON "workflow_secrets"("connectionId");

-- AddForeignKey
ALTER TABLE "application_workflows" ADD CONSTRAINT "application_workflows_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_workflows" ADD CONSTRAINT "application_workflows_executedAsServiceAccountId_fkey" FOREIGN KEY ("executedAsServiceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_connections" ADD CONSTRAINT "workflow_connections_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_connections" ADD CONSTRAINT "workflow_connections_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "workflow_secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "application_workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_createdBySaId_fkey" FOREIGN KEY ("createdBySaId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "application_workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_accessGrantId_fkey" FOREIGN KEY ("accessGrantId") REFERENCES "access_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_triggeredBySaId_fkey" FOREIGN KEY ("triggeredBySaId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_executedAsServiceAccountId_fkey" FOREIGN KEY ("executedAsServiceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_tasks" ADD CONSTRAINT "manual_tasks_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_tasks" ADD CONSTRAINT "manual_tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_tasks" ADD CONSTRAINT "manual_tasks_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_tasks" ADD CONSTRAINT "manual_tasks_completedBySaId_fkey" FOREIGN KEY ("completedBySaId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_secrets" ADD CONSTRAINT "workflow_secrets_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_secrets" ADD CONSTRAINT "workflow_secrets_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "workflow_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Raw SQL Prisma cannot represent in PSL (it neither emits nor reports these on `migrate diff`, so
-- the drift check stays green). Same pattern as the existing partial unique indexes
-- (20260601130000_softdelete_reuse_partial_uniques_citext) and the at-most-one-actor CHECKs
-- (20260602232921_add_service_accounts, 20260604174820_user_history). See ADR-0054 / ADR-0048 /
-- ADR-0041 and docs/05-runbooks/prisma-migrations.md §3.
-- ───────────────────────────────────────────────────────────────────────────────────────────────

-- PARTIAL UNIQUE (ADR-0054 / ADR-0041): at most ONE LIVE ApplicationWorkflow per (applicationId,
-- trigger) — uniqueness scoped to live rows (`"deletedAt" IS NULL`) so a soft-deleted binding frees
-- the slot for reuse/replace and a Restore can reclaim it. A full `@@unique` would re-introduce the
-- ghost-row collision, so this lives here, not in the schema.
CREATE UNIQUE INDEX "application_workflows_applicationId_trigger_active_key"
    ON "application_workflows"("applicationId", "trigger")
    WHERE "deletedAt" IS NULL;

-- AT-MOST-ONE-ACTOR (ADR-0048 / INV-SA-4): at most ONE of (human actor, service-account actor) may
-- be set per attribution axis — never both. An audited action is performed by a human OR a service
-- account, never simultaneously. Prisma cannot express a CHECK in PSL. These are the DB-level
-- guarantee behind ActorService.resolveActor(principal), mirroring the seven existing audit tables.

-- WorkflowVersion author: who wrote this definition snapshot.
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_one_actor"
  CHECK ((("createdById" IS NOT NULL)::int + ("createdBySaId" IS NOT NULL)::int) <= 1);

-- WorkflowRun cause: the triggering human XOR service account (inherited from the grant). NOTE: this
-- covers the TRIGGER axis only; `executedAsServiceAccountId` (the engine principal the run acts AS)
-- is a SEPARATE axis and deliberately NOT part of this CHECK.
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_one_trigger_actor"
  CHECK ((("triggeredById" IS NOT NULL)::int + ("triggeredBySaId" IS NOT NULL)::int) <= 1);

-- ManualTask completion: who resolved the task.
ALTER TABLE "manual_tasks" ADD CONSTRAINT "manual_tasks_one_completion_actor"
  CHECK ((("completedById" IS NOT NULL)::int + ("completedBySaId" IS NOT NULL)::int) <= 1);
