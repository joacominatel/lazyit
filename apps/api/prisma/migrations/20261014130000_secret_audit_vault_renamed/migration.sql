-- AUD-096 (backend audit 2026-10-10): audit a vault RENAME.
-- Additive, non-destructive: a new SecretAuditAction value for the metadata-only row written when a vault
-- is renamed. Existing rows are untouched. Single standalone `ADD VALUE`, like the prior enum bumps.

-- AlterEnum
ALTER TYPE "SecretAuditAction" ADD VALUE 'VAULT_RENAMED';
