-- Version handshake (ADR-0074 / ADR-0083, issue #907): promote the reporting agent's build version
-- from the loose `specs` blob to a first-class, queryable column on the node. The UI compares it to
-- `GET /instance/version` to show an "agent outdated" hint (display-only; never a gate).

-- AlterTable
ALTER TABLE "infra_nodes" ADD COLUMN     "agentVersion" TEXT;

-- Backfill from the inventory blob so already-reported nodes carry their last-seen version
-- immediately (the agent previously stored it under `specs.agentVersion`). NULL specs / absent key
-- stay NULL. Not part of the schema diff — a one-shot data move, safe to re-run.
UPDATE "infra_nodes"
SET "agentVersion" = "specs"->>'agentVersion'
WHERE "specs"->>'agentVersion' IS NOT NULL;
