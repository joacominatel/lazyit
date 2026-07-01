-- #870 (2026-07-01) — audit every human secret REVEAL.
-- Additive, non-destructive: a new SecretAuditAction value for the metadata-only audit row written when a
-- vault member REVEALS a single item's value in the UI. Decryption happens CLIENT-SIDE after the member
-- unlocks the vault (INV-10 / ADR-0061: the server never sees plaintext); this row records ONLY that a
-- per-item reveal occurred — WHO revealed WHICH item, in WHICH vault, when. NEVER a plaintext value,
-- ciphertext, DEK, or wrapped key. Distinct from ITEMS_FETCHED (machine/whole-vault, no itemId — ADR-0080).
-- Hand-written to match prisma's `ADD VALUE` format (NOT applied to any DB in the worktree — the shared
-- dev DB must not be touched by an agent).
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in older PostgreSQL; prisma emits it as
-- a single standalone statement (no wrapping BEGIN/COMMIT), matching the prior ITEMS_EXPORTED /
-- PASSWORD_CHANGED enum-bump migrations.

-- AlterEnum
ALTER TYPE "SecretAuditAction" ADD VALUE 'ITEM_REVEALED';
