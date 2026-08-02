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

-- CreateIndex: the ONE query this table has — the per-node timeline (filter by node, order by id
-- desc, cursor on id). It also serves the per-node write cap's COUNT.
CREATE INDEX "infra_node_fact_changes_nodeId_id_idx" ON "infra_node_fact_changes"("nodeId", "id");

-- AddForeignKey: Cascade, like InfraEdge and InfraNodeSecretRef — a change record is meaningless
-- without the node it describes.
ALTER TABLE "infra_node_fact_changes" ADD CONSTRAINT "infra_node_fact_changes_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "infra_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
