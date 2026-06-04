-- UserHistory (DEBT-2, issue #185) — the User entity's append-only lifecycle log, the counterpart of
-- asset_history for the asset (ADR-0033 / ADR-0006). Emitted transactionally with each Users write and
-- surfaced as the recent_activity view's fourth source (entityType "user"). See ADR-0050.

-- CreateEnum
CREATE TYPE "UserHistoryEventType" AS ENUM ('CREATED', 'UPDATED', 'ROLE_CHANGED', 'DELETED', 'RESTORED', 'PASSWORD_RESET_SENT');

-- CreateTable
CREATE TABLE "user_history" (
    "id" SERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "eventType" "UserHistoryEventType" NOT NULL,
    "payload" JSONB,
    "performedById" UUID,
    "serviceAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_history_userId_id_idx" ON "user_history"("userId", "id");

-- CreateIndex
CREATE INDEX "user_history_createdAt_idx" ON "user_history"("createdAt");

-- AddForeignKey
ALTER TABLE "user_history" ADD CONSTRAINT "user_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_history" ADD CONSTRAINT "user_history_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_history" ADD CONSTRAINT "user_history_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AT-MOST-ONE-ACTOR (ADR-0048): at most ONE of (human actor, service-account actor) may be set on a
-- user_history row — never both. An audited action is performed by a human OR a service account, never
-- simultaneously. Prisma cannot express a CHECK in PSL, so it lives here as raw SQL (mirroring the six
-- existing audit tables added in 20260602232921_add_service_accounts). This is the DB-level guarantee
-- behind ActorService.resolveActor(principal).
ALTER TABLE "user_history" ADD CONSTRAINT "user_history_one_actor"
  CHECK ((("performedById" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);
