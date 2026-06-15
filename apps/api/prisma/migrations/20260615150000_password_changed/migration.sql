-- ADR-0066 (2026-06-15, issue #452) — password is the daily entry credential, recovery key resets it.
-- Additive, non-destructive: a new SecretAuditAction value for the metadata-only audit row written when a
-- user CHANGES (current password) or RESETS (recovery key) their password — i.e. re-wraps ONLY the
-- password wrap (Copy A: privateKeyEncByPassphrase/passphraseSalt/passphraseIv/kdfParams); publicKey + the
-- recovery wrap are untouched. The ADR-0065 RECOVERY_KEY_REGENERATED value is left DORMANT (not dropped —
-- a Postgres enum-value drop needs a risky type recreation). Generated with `prisma migrate diff` (NOT
-- applied to any DB in the worktree).

-- AlterEnum
ALTER TYPE "SecretAuditAction" ADD VALUE 'PASSWORD_CHANGED';
