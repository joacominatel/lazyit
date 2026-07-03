-- Local (first-party) authentication foundation — ADR-0086 (F1a, issue #991).
-- Generated OFFLINE via `prisma migrate diff` (schema-to-schema, NO database connection); the singleton
-- CHECK on instance_config is appended by hand (Prisma cannot express a CHECK), mirroring asset_tag_scheme.

-- AlterTable: additive local-auth credential columns on users. All nullable/defaulted — no backfill.
-- OIDC-linked and directoryOnly users simply never carry a passwordHash. See User model / ADR-0086 §3.
ALTER TABLE "users" ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "passwordUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "sessionEpoch" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: the single-row instance_config holding the persisted AUTH_MODE marker (ADR-0086 §1).
CREATE TABLE "instance_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "authMode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_config_pkey" PRIMARY KEY ("id")
);

-- Single-row guard (ADR-0063 §1 precedent, asset_tag_scheme): pin the id to the fixed "singleton" literal
-- so a SECOND config row is structurally impossible — the table can hold at most one row. Prisma can't
-- express a CHECK, so it is added here as raw SQL. The marker is upserted by this known id (F1c); any
-- insert with another id is rejected by the DB.
ALTER TABLE "instance_config"
    ADD CONSTRAINT "instance_config_singleton" CHECK ("id" = 'singleton');
