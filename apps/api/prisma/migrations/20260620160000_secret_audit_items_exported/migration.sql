-- #612 (2026-06-20) — vault secret export (plaintext via password, or re-encrypted).
-- Additive, non-destructive: a new SecretAuditAction value for the metadata-only audit row written when a
-- vault member EXPORTS the vault's secrets. Decryption happens CLIENT-SIDE after the member unlocks the
-- vault (INV-10 / ADR-0061: the server never sees plaintext); this row records ONLY that an export
-- occurred — WHO exported WHICH vault, when. NEVER a secret value, key, or blob. Hand-written to match
-- prisma's `ADD VALUE` format (NOT applied to any DB in the worktree — the shared dev DB is down).
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in older PostgreSQL; prisma emits it as
-- a single standalone statement (no wrapping BEGIN/COMMIT), matching the prior PASSWORD_CHANGED /
-- RECOVERY_KEY_REGENERATED enum-bump migrations.

-- AlterEnum
ALTER TYPE "SecretAuditAction" ADD VALUE 'ITEMS_EXPORTED';
