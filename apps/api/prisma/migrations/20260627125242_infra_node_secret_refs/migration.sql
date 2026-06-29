-- CreateTable
CREATE TABLE "infra_node_secret_refs" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infra_node_secret_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "infra_node_secret_refs_nodeId_idx" ON "infra_node_secret_refs"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "infra_node_secret_refs_nodeId_vaultId_handle_key" ON "infra_node_secret_refs"("nodeId", "vaultId", "handle");

-- AddForeignKey
ALTER TABLE "infra_node_secret_refs" ADD CONSTRAINT "infra_node_secret_refs_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "infra_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

