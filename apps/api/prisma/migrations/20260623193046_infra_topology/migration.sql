-- CreateEnum
CREATE TYPE "InfraNodeKind" AS ENUM ('PHYSICAL_HOST', 'VM', 'CONTAINER', 'CLUSTER', 'NETWORK_DEVICE', 'STORAGE', 'APPLIANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "InfraNodeStatus" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "InfraNodeSource" AS ENUM ('MANUAL', 'AGENT');

-- CreateEnum
CREATE TYPE "InfraNodeState" AS ENUM ('CONFIRMED', 'PENDING');

-- CreateEnum
CREATE TYPE "InfraEdgeKind" AS ENUM ('RUNS_ON', 'MEMBER_OF', 'DEPENDS_ON', 'BACKS_UP_TO', 'CONNECTS_TO');

-- CreateTable
CREATE TABLE "infra_nodes" (
    "id" TEXT NOT NULL,
    "kind" "InfraNodeKind" NOT NULL,
    "label" TEXT NOT NULL,
    "status" "InfraNodeStatus" NOT NULL DEFAULT 'UNKNOWN',
    "assetId" TEXT,
    "ipAddress" TEXT,
    "shortcuts" JSONB,
    "specs" JSONB,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "source" "InfraNodeSource" NOT NULL DEFAULT 'MANUAL',
    "state" "InfraNodeState" NOT NULL DEFAULT 'CONFIRMED',
    "reportingSource" TEXT,
    "externalId" TEXT,
    "lastReportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "infra_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infra_edges" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "kind" "InfraEdgeKind" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "infra_edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "infra_nodes_assetId_idx" ON "infra_nodes"("assetId");

-- CreateIndex
CREATE INDEX "infra_nodes_kind_idx" ON "infra_nodes"("kind");

-- CreateIndex
CREATE INDEX "infra_nodes_state_idx" ON "infra_nodes"("state");

-- CreateIndex
CREATE INDEX "infra_edges_sourceId_idx" ON "infra_edges"("sourceId");

-- CreateIndex
CREATE INDEX "infra_edges_targetId_idx" ON "infra_edges"("targetId");

-- CreateIndex
CREATE INDEX "infra_edges_kind_idx" ON "infra_edges"("kind");

-- AddForeignKey
ALTER TABLE "infra_nodes" ADD CONSTRAINT "infra_nodes_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infra_edges" ADD CONSTRAINT "infra_edges_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "infra_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infra_edges" ADD CONSTRAINT "infra_edges_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "infra_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Two PARTIAL UNIQUE indexes Prisma cannot express in PSL (the partial-index precedent — ADR-0019,
-- docs/05-runbooks/prisma-migrations.md §3). Columns are camelCase (lazyit maps only table names via
-- @@map, not columns). The enum value is cast to its type in the WHERE clause. See ADR-0070 §3.

-- (1) "One active host per source": at most one ACTIVE RUNS_ON edge per source node. Released/closed
-- (endedAt set) rows are exempt, so a host migration (close one RUNS_ON, open the next) is fine, and
-- the OTHER kinds (MEMBER_OF/DEPENDS_ON/BACKS_UP_TO/CONNECTS_TO) are legitimately many — unconstrained.
CREATE UNIQUE INDEX "infra_edges_source_active_runs_on_key"
    ON "infra_edges"("sourceId")
    WHERE "endedAt" IS NULL AND "kind" = 'RUNS_ON'::"InfraEdgeKind";

-- (2) Canonical-pair uniqueness for the SYMMETRIC CONNECTS_TO: at most one ACTIVE connection per
-- ordered (sourceId, targetId). The API canonicalizes the pair (stores the lower id as source) so the
-- pair is unique regardless of input order; this index is the race-proof DB backstop on the active set.
CREATE UNIQUE INDEX "infra_edges_connects_to_pair_active_key"
    ON "infra_edges"("sourceId", "targetId")
    WHERE "kind" = 'CONNECTS_TO'::"InfraEdgeKind" AND "endedAt" IS NULL;
