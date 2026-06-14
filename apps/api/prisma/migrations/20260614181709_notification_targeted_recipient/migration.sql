-- ADR-0056 amendment (2026-06-14, issue #453) — targeted per-user notifications.
-- Additive, non-destructive: a nullable `recipientUserId` (who SEES the notification, distinct from
-- `targetUserId` who it is ABOUT). null = the existing admin broadcast; a uuid = a TARGETED nudge in
-- that user's own bell. FK to users(id) ON DELETE SET NULL (mirrors targetUserId) so losing the
-- recipient never blocks deletion and the event survives. Indexed for the per-user targeted-feed scan.

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "recipientUserId" UUID;

-- CreateIndex
CREATE INDEX "notifications_recipientUserId_idx" ON "notifications"("recipientUserId");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
