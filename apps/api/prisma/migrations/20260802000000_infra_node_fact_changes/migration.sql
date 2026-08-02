-- Append-only infra node fact history (ADR-0074 §3 amendment, issue #1143). ADDITIVE ONLY (STANDING
-- RULE #8, upgrade-safe over live data): one new enum and one new table. No column is added to, and
-- no data is changed on, any existing table — `infra_nodes` gains only the Prisma-side relation
-- field, which is not a column. Nothing is backfilled and nothing needs to be: the diff SEEDS its
-- baseline from the first observation of each fact, so an estate upgrading into this starts with an
-- empty table and records its first row the first time something actually moves.

-- CreateEnum
CREATE TYPE "InfraFactChangeKind" AS ENUM ('PACKAGE_ADDED', 'PACKAGE_REMOVED', 'PACKAGE_VERSION', 'FACT_CHANGED');

-- CreateTable: append-only (ADR-0006) — createdAt only, no updatedAt, no deletedAt.
CREATE TABLE "infra_node_fact_changes" (
    "id" SERIAL NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" "InfraFactChangeKind" NOT NULL,
    "fact" TEXT NOT NULL,
    "previousValue" TEXT,
    "currentValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infra_node_fact_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the READ — the per-node timeline (filter by node, order by id desc, cursor on id).
CREATE INDEX "infra_node_fact_changes_nodeId_id_idx" ON "infra_node_fact_changes"("nodeId", "id");

-- CreateIndex: the WRITE CAP — the rolling-hour COUNT the report ingest runs before it appends.
-- Its predicate is `("nodeId" = $1 AND "createdAt" >= $2)`, a RANGE on createdAt, which the index
-- above cannot answer: it could only walk every row the node owns and re-check each one. That is
-- the wrong shape for an abuse cap, because nothing prunes this table and the node holding the most
-- rows is by definition the abused one — the mitigation would collapse exactly when it fires, on
-- the ingest path. Measured on postgres:18-alpine (the image compose.yaml pins) with 2.16M rows on
-- one node, EXPLAIN-ing the SQL Prisma actually emits for that COUNT: WITHOUT this index a parallel
-- seq scan, 18,374 buffers, 2.16M rows discarded by the filter, 38.6 ms; WITH it an index-only
-- scan, 7 buffers, 0 heap fetches, 0.11 ms. The timeline query above keeps its own plan.
CREATE INDEX "infra_node_fact_changes_nodeId_createdAt_idx" ON "infra_node_fact_changes"("nodeId", "createdAt");

-- AddForeignKey: Cascade, like InfraEdge and InfraNodeSecretRef — a change record is meaningless
-- without the node it describes.
ALTER TABLE "infra_node_fact_changes" ADD CONSTRAINT "infra_node_fact_changes_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "infra_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
