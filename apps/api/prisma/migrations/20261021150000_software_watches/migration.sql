-- The software watchlist (#1684, split from epic #1146 item 4).
--
-- ADDITIVE ONLY: one new table. No existing table is touched, nothing is dropped or made NOT NULL
-- without a default, and there is nothing to backfill — an instance that upgrades lands with an
-- empty watchlist, and nothing else on the instance reads this table. The distribution each watch
-- shows is computed on read from data agents already stored (`infra_nodes.specs`), so it is complete
-- from the first watch an operator adds.

-- CreateTable
CREATE TABLE "software_watches" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "software_watches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "software_watches_createdById_idx" ON "software_watches"("createdById");

-- One LIVE watch per normalized name. Partial, so a soft-deleted watch frees its name for a new one
-- (the `secret_vaults_name_live_key` shape). Not expressible in schema.prisma, hence raw SQL here.
CREATE UNIQUE INDEX "software_watches_name_live_key"
    ON "software_watches"("name")
    WHERE "deletedAt" IS NULL;

-- AddForeignKey
-- SetNull, never Cascade: a watch is a shared fleet view, and deleting the operator who added it must
-- not remove it.
ALTER TABLE "software_watches" ADD CONSTRAINT "software_watches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
