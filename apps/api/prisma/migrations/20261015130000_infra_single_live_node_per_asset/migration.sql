-- One live node per asset (ADR-0070 §5, AUD-030/031): the API already refuses a second link, and this
-- index closes the race that check cannot. Raw SQL because PSL cannot express the WHERE filter
-- (docs/05-runbooks/prisma-migrations.md §3).
--
-- Existing shared links would block the index. For each asset, the OLDEST live node (createdAt, then
-- id) keeps it; the others lose only the link. No row is deleted and no other column is written.
WITH ranked AS (
    SELECT "id",
           ROW_NUMBER() OVER (
               PARTITION BY "assetId"
               ORDER BY "createdAt" ASC, "id" ASC
           ) AS rn
    FROM "infra_nodes"
    WHERE "deletedAt" IS NULL
      AND "assetId" IS NOT NULL
)
UPDATE "infra_nodes" AS n
SET "assetId" = NULL
FROM ranked
WHERE n."id" = ranked."id"
  AND ranked.rn > 1;

CREATE UNIQUE INDEX "infra_nodes_assetId_active_key"
    ON "infra_nodes" ("assetId")
    WHERE "deletedAt" IS NULL
      AND "assetId" IS NOT NULL;
