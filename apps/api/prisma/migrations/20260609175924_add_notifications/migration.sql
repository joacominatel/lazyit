-- In-app notification bell (ADR-0056). An APPEND-ONLY `notifications` event store (createdAt only — no
-- updatedAt/deletedAt, the AssetHistory/AccessGrant immutable-event precedent, ADR-0006/0033/0023) of
-- curated operational nudges, plus a per-admin `notification_reads` join (fan-out-on-READ: a row's
-- ABSENCE = unread for that admin). `dedupeKey` is UNIQUE so emitters are idempotent (a retry / a
-- flapping consumable collapses to ONE row, ADR-0056 §4). The read join's FK to the event is RESTRICT
-- (the 90-day retention sweep deletes the joins first, then the event — the only deleter); its FK to the
-- user is CASCADE (losing a user drops only that user's read rows, never the event); the event's
-- optional `targetUserId` FK is SetNull (the person subject can vanish without blocking deletion).

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "dedupeKey" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "targetUserId" UUID,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_reads" (
    "id" SERIAL NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_type_createdAt_idx" ON "notifications"("type", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "notification_reads_userId_idx" ON "notification_reads"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_reads_notificationId_userId_key" ON "notification_reads"("notificationId", "userId");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
