-- CreateEnum
CREATE TYPE "ConsumableMovementType" AS ENUM ('IN', 'OUT', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "consumable_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "order" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "consumable_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumables" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "categoryId" TEXT,
    "description" TEXT,
    "currentStock" INTEGER NOT NULL DEFAULT 0,
    "minStock" INTEGER,
    "unit" TEXT NOT NULL DEFAULT 'units',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "consumables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumable_movements" (
    "id" SERIAL NOT NULL,
    "consumableId" TEXT NOT NULL,
    "type" "ConsumableMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "performedById" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumable_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consumable_categories_name_key" ON "consumable_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "consumables_sku_key" ON "consumables"("sku");

-- CreateIndex
CREATE INDEX "consumables_categoryId_idx" ON "consumables"("categoryId");

-- CreateIndex
CREATE INDEX "consumable_movements_consumableId_id_idx" ON "consumable_movements"("consumableId", "id");

-- AddForeignKey
ALTER TABLE "consumables" ADD CONSTRAINT "consumables_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "consumable_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_consumableId_fkey" FOREIGN KEY ("consumableId") REFERENCES "consumables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

