-- The composite PARTIAL UNIQUE index DEFERRED by 20260623193046_infra_topology (ADR-0070 §4) and added
-- now by the server reporting agent (ADR-0074 §3). The dedup key is (reportingSource, externalId): one
-- host = one node, forever, across every report. Prisma's PSL `@@unique` CANNOT express a WHERE filter,
-- so this is hand-written raw SQL — the same partial-index precedent as `secret_items_handle_live_key`
-- and the topology RUNS_ON/CONNECTS_TO indexes (see docs/05-runbooks/prisma-migrations.md §3).
--
-- Columns are camelCase + quoted (lazyit maps only table names via @@map, not columns). The filter:
--   - "deletedAt" IS NULL   → a soft-deleted (off-the-map) node frees its key, so the host can be
--                             re-discovered into a fresh node later (matches the soft-delete posture).
--   - both keys NOT NULL    → MANUAL nodes (hand-entered, no reporting keys) are NEVER constrained;
--                             only AGENT-reported nodes, which always carry both keys, are deduped.
CREATE UNIQUE INDEX "infra_nodes_reporting_source_external_id_key"
    ON "infra_nodes" ("reportingSource", "externalId")
    WHERE "deletedAt" IS NULL
      AND "reportingSource" IS NOT NULL
      AND "externalId" IS NOT NULL;
