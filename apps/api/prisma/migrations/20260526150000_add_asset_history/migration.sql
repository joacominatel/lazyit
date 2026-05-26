-- CreateEnum
CREATE TYPE "AssetHistoryEventType" AS ENUM ('CREATED', 'STATUS_CHANGED', 'ASSIGNED', 'RELEASED', 'LOCATION_CHANGED', 'MODEL_CHANGED', 'SPECS_CHANGED', 'DELETED', 'RESTORED');

-- CreateTable
CREATE TABLE "asset_history" (
    "id" SERIAL NOT NULL,
    "assetId" TEXT NOT NULL,
    "eventType" "AssetHistoryEventType" NOT NULL,
    "payload" JSONB,
    "performedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_history_assetId_id_idx" ON "asset_history"("assetId", "id");

-- AddForeignKey
ALTER TABLE "asset_history" ADD CONSTRAINT "asset_history_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_history" ADD CONSTRAINT "asset_history_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

