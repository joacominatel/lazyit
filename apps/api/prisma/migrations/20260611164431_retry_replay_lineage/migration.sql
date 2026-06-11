-- ADR-0057 (retry-after-fix & replay): the replay sequence within (trigger, accessGrantId) and the
-- self-FK lineage link. Existing rows default replaySeq = 0 (they ARE the organic grant run).
-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "replaySeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "supersedesRunId" TEXT;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_supersedesRunId_fkey" FOREIGN KEY ("supersedesRunId") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the idempotencyKey to the uniform "<trigger>:<accessGrantId>:<replaySeq>" form (ADR-0057).
-- Pre-0057 keys are "<trigger>:<accessGrantId>" — neither a trigger (enum word) nor a cuid contains a
-- colon, so a legacy grant key has EXACTLY one ':'. Append ':0' to those only (idempotent: a key that
-- already has two colons — none exist yet, but be safe — is left untouched). The column is UNIQUE; this
-- rewrite is collision-free because it maps each distinct 2-segment key to a distinct 3-segment key.
UPDATE "workflow_runs"
SET "idempotencyKey" = "idempotencyKey" || ':0'
WHERE "accessGrantId" IS NOT NULL
  AND length("idempotencyKey") - length(replace("idempotencyKey", ':', '')) = 1;
