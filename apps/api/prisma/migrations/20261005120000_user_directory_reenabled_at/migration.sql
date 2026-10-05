-- Manual re-enable sticks against the directory sync (ADR-0091, #1522). ADDITIVE ONLY: one nullable column,
-- no default, no backfill, no index (the sweep already loads every AD-sourced person in one query).
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: nothing is rewritten. Every row reads NULL, so no person is marked
-- as re-enabled by hand. The column is set from the next active→inactive→active flip an admin makes.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "directoryReenabledAt" TIMESTAMP(3);
