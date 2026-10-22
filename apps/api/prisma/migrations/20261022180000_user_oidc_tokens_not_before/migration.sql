-- OIDC "sign out everywhere" cutoff (#1715, ADR-0097 decision 8 amended 2026-10-22).
--
-- ADDITIVE ONLY: one nullable column on `users`. Nothing is dropped, renamed or made NOT NULL, and there
-- is nothing to backfill.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: every existing user reads `oidcTokensNotBefore = NULL`, which
-- means "no cutoff": the OIDC guard accepts exactly the IdP tokens it accepted before the update, and
-- nobody is signed out by the deploy. The column is set only by a later "Sign out everywhere and
-- disconnect AI apps", deactivation, offboarding or directory-sync soft offboard. Local and shim
-- instances never read it. No index: it is read only on the user row the guard already loads.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "oidcTokensNotBefore" TIMESTAMP(3);
