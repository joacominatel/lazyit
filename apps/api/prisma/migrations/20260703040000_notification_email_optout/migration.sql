-- Per-user, per-type EMAIL opt-out for notifications — issue #879. Adds one array column to `users`
-- listing the `NotificationType` values a user has opted OUT of receiving by EMAIL (the in-app bell is
-- UNAFFECTED — this is an email-channel filter only). OPT-OUT semantics / default-ON: the default empty
-- array means "receives every emailable type"; a type present drops the user from that type's email
-- audience (EmailDispatchService.resolveRecipientEmails, both the targeted and the broadcast path).
-- Generated OFFLINE via `prisma migrate diff` (schema-to-schema, NO database connection) — mirrors the
-- local-auth migration precedents. Additive + defaulted, so no backfill and no lock risk on existing rows.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notificationEmailOptOutTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];
