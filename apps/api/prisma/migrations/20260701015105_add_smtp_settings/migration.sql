-- CreateTable
CREATE TABLE "smtp_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT,
    "port" INTEGER,
    "security" TEXT NOT NULL DEFAULT 'starttls',
    "username" TEXT,
    "passwordCiphertext" TEXT,
    "passwordIv" TEXT,
    "passwordAuthTag" TEXT,
    "passwordKeyVersion" INTEGER,
    "fromAddress" TEXT,
    "fromName" TEXT,
    "rejectUnauthorized" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smtp_settings_pkey" PRIMARY KEY ("id")
);

-- Single-row guard (ADR-0079, mirrors ADR-0063 §1): pin the id to the fixed "singleton" literal so a
-- SECOND SMTP config row is structurally impossible — the table can hold at most one row. Prisma can't
-- express a CHECK, so it is added here as raw SQL. The service upserts by this known id; any insert with
-- another id is rejected by the DB.
ALTER TABLE "smtp_settings"
    ADD CONSTRAINT "smtp_settings_singleton" CHECK ("id" = 'singleton');
