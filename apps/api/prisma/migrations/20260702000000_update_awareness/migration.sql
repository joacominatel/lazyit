-- Update awareness & guided update (ADR-0084, issue #904).
-- Two tables: the singleton update-check config/cache (update_settings) and the append-only guided-update
-- ledger (update_runs). The core DDL below is byte-for-byte `prisma migrate diff`; the singleton CHECK on
-- update_settings is added as raw SQL (Prisma cannot express a CHECK), mirroring smtp_settings/asset_tag_scheme.

-- CreateTable
CREATE TABLE "update_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "checkEnabled" BOOLEAN NOT NULL DEFAULT false,
    "latestVersion" TEXT,
    "behindBy" INTEGER NOT NULL DEFAULT 0,
    "latestHtmlUrl" TEXT,
    "latestNotes" TEXT,
    "checkedAt" TIMESTAMP(3),
    "lastEmailedVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "update_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "update_runs" (
    "id" SERIAL NOT NULL,
    "requestedByUserId" UUID,
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "logTail" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "update_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "update_runs_status_idx" ON "update_runs"("status");

-- CreateIndex
CREATE INDEX "update_runs_createdAt_idx" ON "update_runs"("createdAt");

-- AddForeignKey
ALTER TABLE "update_runs" ADD CONSTRAINT "update_runs_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Single-row guard (ADR-0084, mirrors ADR-0079 smtp_settings / ADR-0063 asset_tag_scheme): pin the id to
-- the fixed "singleton" literal so a SECOND update-settings row is structurally impossible — the table can
-- hold at most one row. Prisma can't express a CHECK, so it is added here as raw SQL. The service upserts by
-- this known id; any insert with another id is rejected by the DB. (update_runs is a real ledger — no guard.)
ALTER TABLE "update_settings"
    ADD CONSTRAINT "update_settings_singleton" CHECK ("id" = 'singleton');
