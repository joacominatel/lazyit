-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('OFFICE', 'DATACENTER', 'RACK', 'REMOTE', 'STORAGE', 'OTHER');

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "description" TEXT,
    "address" TEXT,
    "floor" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);
