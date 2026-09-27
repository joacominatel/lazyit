-- Seed-once ledger for the default role→permission grants (issue #1314, ADR-0046 §4 note).
-- The seed runs on every deploy and, before this table existed, upserted every default pair — so a
-- default an admin had revoked came back on the next update. From now on the seed grants a default
-- pair only when it has no row here, then records it.
--
-- Additive only: a new table plus a backfill into it. No row of "role_permissions" is touched, so
-- every grant an instance holds today is kept.

-- CreateTable
CREATE TABLE "applied_role_permission_defaults" (
    "role" "Role" NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applied_role_permission_defaults_pkey" PRIMARY KEY ("role","permission")
);

-- Backfill: mark as settled every pair the instance already holds, and every pair the audit log shows
-- an admin revoked (currently absent, or re-granted since by an older seed). The seed will therefore
-- never grant these again. A default pair that appears in neither set was never applied here (a
-- release that shipped it was skipped, or it is new), and the next seed applies it once — exactly
-- what the old upsert would have done on this deploy. ON CONFLICT keeps the statement idempotent.
INSERT INTO "applied_role_permission_defaults" ("role", "permission")
SELECT "role", "permission" FROM "role_permissions"
UNION
SELECT "role", "permission" FROM "permission_audit_log" WHERE "action" = 'REVOKE'
ON CONFLICT ("role", "permission") DO NOTHING;
