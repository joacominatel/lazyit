-- Security-severity flag on releases (issue #908, ADR-0083/0084 amendment).
-- Two cached booleans on the singleton update-check config: `securityRelevant` (does the current gap
-- contain a SECURITY-marked release — surfaced by the card + endpoint) and `lastEmailedSecurity` (the
-- second half of the weekly-email de-dupe, so a version that flips to security-relevant after a routine
-- email re-fires exactly once). Both default false; derived from the releases list at check time.

-- AlterTable
ALTER TABLE "update_settings" ADD COLUMN     "lastEmailedSecurity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "securityRelevant" BOOLEAN NOT NULL DEFAULT false;
