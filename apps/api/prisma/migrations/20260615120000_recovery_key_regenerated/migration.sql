-- ADR-0065 (2026-06-15, issue #452) — regenerate the recovery key for an existing keypair.
-- Additive, non-destructive: a new SecretAuditAction value for the metadata-only audit row written when
-- a user re-mints ONLY the recovery wrap of their keypair (publicKey + passphrase wrap + kdfParams
-- untouched). Generated with `prisma migrate diff` (NOT applied to any DB in the worktree).

-- AlterEnum
ALTER TYPE "SecretAuditAction" ADD VALUE 'RECOVERY_KEY_REGENERATED';
