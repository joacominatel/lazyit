-- Issue #1422: per-user UI preferences (language + colour theme).
-- Additive and nullable, no backfill: every existing user reads NULL = "never chosen", which keeps
-- today's per-browser behaviour until the user picks a language or theme again.
ALTER TABLE "users" ADD COLUMN "locale" TEXT;
ALTER TABLE "users" ADD COLUMN "theme" TEXT;
