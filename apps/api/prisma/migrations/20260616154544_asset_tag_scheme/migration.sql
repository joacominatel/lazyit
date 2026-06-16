-- CreateTable
CREATE TABLE "asset_tag_scheme" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "prefix" TEXT,
    "suffix" TEXT,
    "width" INTEGER,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_tag_scheme_pkey" PRIMARY KEY ("id")
);

-- Single-row guard (ADR-0063 §1): pin the id to the fixed "singleton" literal so a SECOND config row
-- is structurally impossible — the table can hold at most one row. Prisma can't express a CHECK, so
-- it is added here as raw SQL (the partial-unique-index precedent, ADR-0041). The service upserts by
-- this known id; any insert with another id is rejected by the DB.
ALTER TABLE "asset_tag_scheme"
    ADD CONSTRAINT "asset_tag_scheme_singleton" CHECK ("id" = 'singleton');
