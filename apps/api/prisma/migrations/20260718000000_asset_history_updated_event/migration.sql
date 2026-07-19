-- Re-import mutate-on-match (#1061) — a bulk import that matches a LIVE asset by serial now UPDATES it
-- instead of creating a duplicate, and emits an AssetHistory "updated via re-import" entry. When no
-- tracked dimension changed there is no per-dimension change event to record, so we add a whole-asset
-- UPDATED marker (mirrors UserHistoryEventType.UPDATED) — the provenance `{ source:'import', ... }` rides
-- its jsonb payload. Additive, non-destructive. Hand-written to match prisma's `ADD VALUE` format (NOT
-- applied to any DB in the worktree — the shared dev DB is not reachable here).
--
-- The `recent_activity` view (ADR-0050) reads the asset branch generically — `lower(ah."eventType"::text)`
-- and `'Asset ' || lower(replace(ah."eventType"::text, '_', ' '))` — so the freshly-added value is matched
-- as TEXT (never an enum literal in this transaction) and needs NO view change; an UPDATED event simply
-- surfaces as action `updated` / summary `Asset updated`. Appended at the tail so the DB enum order matches
-- the schema.prisma declaration.

-- AlterEnum
ALTER TYPE "AssetHistoryEventType" ADD VALUE 'UPDATED';
