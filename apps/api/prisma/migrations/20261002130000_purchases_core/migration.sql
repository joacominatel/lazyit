-- Purchases core (ADR-0099, #1472): suppliers, purchase orders, their lines and the append-only purchase
-- activity log, plus two nullable columns on assets.
--
-- Additive only. Four NEW tables and two NULLABLE columns on "assets" with no default: every existing asset
-- reads purchaseCurrency = NULL ("No currency") and purchaseOrderLineId = NULL ("no purchase"). No backfill,
-- no row is rewritten, no enum is created or altered (status, kind and eventType are TEXT validated by zod
-- on write, so a value a newer build adds needs no migration). No uniqueness index anywhere (CEO decision
-- D-D: entry is light; duplicates are suggestions, never refusals). The FK on assets is validated against
-- a column that is NULL on every row, and nothing in the recent_activity view references the new columns.

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "purchaseCurrency" TEXT,
ADD COLUMN     "purchaseOrderLineId" TEXT;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "website" TEXT,
    "salesContactName" TEXT,
    "salesContactEmail" TEXT,
    "salesContactPhone" TEXT,
    "supportContactName" TEXT,
    "supportContactEmail" TEXT,
    "supportContactPhone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "reference" TEXT,
    "supplierId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "currency" TEXT,
    "orderDate" TIMESTAMP(3),
    "expectedDate" TIMESTAMP(3),
    "deliveryLocationId" TEXT,
    "company" TEXT,
    "invoiceNumbers" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'ASSET',
    "description" TEXT NOT NULL,
    "manufacturerText" TEXT,
    "modelText" TEXT,
    "assetModelId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" BIGINT,
    "cancelledQuantity" INTEGER NOT NULL DEFAULT 0,
    "warrantyMonths" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_events" (
    "id" SERIAL NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB,
    "performedById" UUID,
    "serviceAccountId" TEXT,
    "aiInvocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_orders_supplierId_idx" ON "purchase_orders"("supplierId");

-- CreateIndex
CREATE INDEX "purchase_order_lines_purchaseOrderId_idx" ON "purchase_order_lines"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "purchase_order_lines_assetModelId_idx" ON "purchase_order_lines"("assetModelId");

-- CreateIndex
CREATE INDEX "purchase_order_events_purchaseOrderId_id_idx" ON "purchase_order_events"("purchaseOrderId", "id");

-- CreateIndex
CREATE INDEX "assets_purchaseOrderLineId_idx" ON "assets"("purchaseOrderLineId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_deliveryLocationId_fkey" FOREIGN KEY ("deliveryLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_assetModelId_fkey" FOREIGN KEY ("assetModelId") REFERENCES "asset_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_events" ADD CONSTRAINT "purchase_order_events_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_events" ADD CONSTRAINT "purchase_order_events_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_events" ADD CONSTRAINT "purchase_order_events_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AT-MOST-ONE-ACTOR (ADR-0048, INV-SA-4): a purchase event is attributed to a human OR a service account,
-- never both. Prisma cannot express a CHECK in PSL, so it lives here as raw SQL, mirroring asset_history,
-- consumable_movements and user_history. The DB-level guarantee behind ActorService.resolveActor(principal).
ALTER TABLE "purchase_order_events" ADD CONSTRAINT "purchase_order_events_one_actor"
  CHECK ((("performedById" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);
