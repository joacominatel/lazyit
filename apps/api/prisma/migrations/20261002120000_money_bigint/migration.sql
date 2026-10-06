-- Money as 64-bit integer minor units (ADR-0100, #1469). Widens the three money columns from int4 to
-- bigint so an amount can exceed 21,474,836.47 major units.
--
-- Non-destructive: every int4 value is a valid bigint, NULL stays NULL, and no row changes meaning. No
-- backfill. The type change is not binary-compatible, so PostgreSQL rewrites each table under an ACCESS
-- EXCLUSIVE lock for the duration (seconds at lazyit's scale). No index, view, function or trigger
-- references these columns — the "recent_activity" view joins "assets" and "applications" on other
-- columns only — so nothing has to be dropped and recreated around the change.

-- AlterTable
ALTER TABLE "assets" ALTER COLUMN "purchaseCost" SET DATA TYPE BIGINT,
ALTER COLUMN "salvageValue" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "applications" ALTER COLUMN "costPerSeat" SET DATA TYPE BIGINT;
