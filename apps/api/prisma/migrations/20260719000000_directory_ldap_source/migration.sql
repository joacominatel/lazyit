-- On-prem AD/LDAP directory source (ADR-0091, issue #839). ADDITIVE + nullable/defaulted only
-- (STANDING RULE #8, upgrade-safe over live data): three nullable columns on `users`, a new singleton
-- `directory_connection` config table, its SA-attribution FK (SetNull). The pieces Prisma cannot express
-- in PSL — the LIVE-scoped partial unique on `directorySourceId` and the singleton-id CHECK — are appended
-- as raw SQL at the bottom, mirroring the legajo/username partial-unique precedent (20260611180848) and
-- the SmtpSettings/UpdateSettings singleton CHECKs.

-- AlterTable: AD-directory-source provenance on User. All nullable, no backfill — every existing row
-- (login users, import-sourced directory persons) reads NULL and is untouched.
ALTER TABLE "users" ADD COLUMN     "directoryOffboardedAt" TIMESTAMP(3),
ADD COLUMN     "directorySource" TEXT,
ADD COLUMN     "directorySourceId" TEXT;

-- CreateTable: the singleton DirectoryConnection config row (off by default).
CREATE TABLE "directory_connection" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT,
    "port" INTEGER,
    "transport" TEXT NOT NULL DEFAULT 'ldaps',
    "rejectUnauthorized" BOOLEAN NOT NULL DEFAULT true,
    "baseDN" TEXT,
    "bindDN" TEXT,
    "searchFilter" TEXT,
    "attributeMap" JSONB,
    "offboardGraceDays" INTEGER NOT NULL DEFAULT 7,
    "bindPasswordCiphertext" TEXT,
    "bindPasswordIv" TEXT,
    "bindPasswordAuthTag" TEXT,
    "bindPasswordKeyVersion" INTEGER,
    "serviceAccountId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncCounts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "directory_connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "directory_connection_serviceAccountId_idx" ON "directory_connection"("serviceAccountId");

-- AddForeignKey: SA attribution — SetNull so hard-deleting the SA reverts the config to a system actor.
ALTER TABLE "directory_connection" ADD CONSTRAINT "directory_connection_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial UNIQUE index on `directorySourceId` (ADR-0091 / ADR-0041). The AD objectGUID (canonical GUID
-- string) is the immutable natural key the reconcile upserts on. UNIQUE among LIVE rows only
-- (`"deletedAt" IS NULL`), and only when SET (`"directorySourceId" IS NOT NULL`), so: a soft-deleted
-- (offboarded) person frees its GUID for reuse, and the vast majority of users (no directory source,
-- NULL) never participate. Prisma can't express a partial unique — raw SQL here, no `@unique` on the
-- column (that would emit a FULL unique index and collide across soft-deleted rows).
CREATE UNIQUE INDEX "users_directorySourceId_active_key"
    ON "users"("directorySourceId")
    WHERE "deletedAt" IS NULL AND "directorySourceId" IS NOT NULL;

-- Singleton CHECK: pin the DirectoryConnection id so a second config row is structurally impossible
-- (mirrors the SmtpSettings/UpdateSettings/AssetTagScheme singleton CHECKs).
ALTER TABLE "directory_connection" ADD CONSTRAINT "directory_connection_singleton"
  CHECK ("id" = 'singleton');
