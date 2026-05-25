-- AlterTable
ALTER TABLE "users" ADD COLUMN "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_externalId_key" ON "users"("externalId");
