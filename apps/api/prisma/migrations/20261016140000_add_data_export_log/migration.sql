-- ADR-0103 (#1597): the append-only DataExportLog, one row per server-side data export. ADDITIVE ONLY: a new
-- table, its indexes, its foreign keys and an at-most-one-actor CHECK. No existing table or row is touched.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: nothing. The table starts empty; exports run before this update
-- left no trace and are not backfilled.

-- CreateTable
CREATE TABLE "data_export_logs" (
    "id" SERIAL NOT NULL,
    "actorId" UUID,
    "serviceAccountId" TEXT,
    "resource" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_export_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_export_logs_actorId_id_idx" ON "data_export_logs"("actorId", "id");

-- CreateIndex
CREATE INDEX "data_export_logs_serviceAccountId_id_idx" ON "data_export_logs"("serviceAccountId", "id");

-- CreateIndex
CREATE INDEX "data_export_logs_resource_id_idx" ON "data_export_logs"("resource", "id");

-- CreateIndex
CREATE INDEX "data_export_logs_createdAt_idx" ON "data_export_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "data_export_logs" ADD CONSTRAINT "data_export_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_export_logs" ADD CONSTRAINT "data_export_logs_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AT-MOST-ONE-ACTOR (ADR-0048, INV-SA-4): an export is attributed to a human OR a service account, never both.
ALTER TABLE "data_export_logs" ADD CONSTRAINT "data_export_logs_one_actor"
  CHECK ((("actorId" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);
