-- Chassis routing + adoption by corroborated serial (ADR-0093, issue #1198). ADDITIVE ONLY
-- (STANDING RULE #8, upgrade-safe over live data): one new enum VALUE and two new nullable columns.
-- No column is dropped, no column is made NOT NULL, no default is introduced, nothing is backfilled
-- and no existing row is touched. It applies to a populated production database through
-- `prisma migrate deploy` with no data loss and no maintenance window.
--
-- WHAT AN OPERATOR SEES, IN ORDER:
--   1. Nothing moves at the moment of the migration. Every existing `infra_nodes` row has
--      `chassis = NULL`, which the contract reads as NO SIGNAL, which is exactly today's behaviour —
--      the map is identical the second after this runs as the second before.
--   2. The estate SELF-HEALS within one report cadence. Every agent-reported node re-reports on its
--      own timer and writes its own `chassis` then, so the column fills without a backfill script and
--      without a data migration that could be wrong (the same lazy-fill posture #1153 used for stored
--      software lists). A manual node and a CONTAINER child stay NULL forever, correctly: neither has
--      a form factor to report.
--   3. Only THEN does the map get smaller, as endpoints acquire a chassis and drop off the canvas.
--      Reversible in one click, and nothing left the CMDB.
--   4. Adoption is ENFORCE-ONLY-ON-WRITE: it changes what a FUTURE confirm does. Already-confirmed
--      nodes are never re-linked retroactively.

-- AlterEnum: the ACKNOWLEDGED precedent. `ADD VALUE` APPENDS to the type — it never rewrites the
-- table and never rewrites the enum's existing members, so it is O(1) on a populated `asset_history`.
-- Safe inside this migration's transaction on PostgreSQL 12+ (the compose image pins 18) because the
-- new value is NOT USED within the same transaction: only future INSERTs reference it. The value is
-- appended at the tail here and at the tail of the PSL enum, so the two orders stay in step.
ALTER TYPE "AssetHistoryEventType" ADD VALUE 'AGENT_LINKED';

-- AlterTable: the agent-owned host form factor (§2). TEXT rather than a Postgres enum, deliberately —
-- the wire vocabulary degrades an unrecognised value to "absent" so a report is never rejected for it,
-- and an enum column would turn that same value into a write error on the hot report path. Validation
-- lives in shared zod at the write boundary. No index: the canvas filters client-side over the rows it
-- already fetches (§5), so there is no query for one to serve.
ALTER TABLE "infra_nodes" ADD COLUMN "chassis" TEXT;

-- AlterTable: chassis as an auto-confirm rule CONDITION (§6). Same storage shape as the node column,
-- so one vocabulary has one representation. Nullable = "this rule does not test chassis", which is
-- what every existing rule reads as — no rule changes behaviour on upgrade.
ALTER TABLE "infra_auto_confirm_rules" ADD COLUMN "chassis" TEXT;
