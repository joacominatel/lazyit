-- One live node per asset: the latest reporter keeps the link (then the oldest), so a re-imaged host's dead predecessor is the one un-linked (never deleted) and stamped _infraAssetUnlinked.
WITH ranked AS (
    SELECT "id",
           ROW_NUMBER() OVER w AS rn,
           FIRST_VALUE("id") OVER w AS "keptNodeId"
    FROM "infra_nodes"
    WHERE "deletedAt" IS NULL
      AND "assetId" IS NOT NULL
    WINDOW w AS (PARTITION BY "assetId" ORDER BY "lastReportedAt" DESC NULLS LAST, "createdAt" ASC, "id" ASC)
)
UPDATE "infra_nodes" AS n
SET "assetId" = NULL,
    "specs" = CASE
        WHEN jsonb_typeof(COALESCE(n."specs", 'null'::jsonb)) IN ('object', 'null')
        THEN COALESCE(NULLIF(n."specs", 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(
            '_infraAssetUnlinked',
            jsonb_build_object(
                'assetId', n."assetId",
                'keptByNodeId', ranked."keptNodeId",
                'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
        )
        ELSE n."specs"
    END
FROM ranked
WHERE n."id" = ranked."id"
  AND ranked.rn > 1;

CREATE UNIQUE INDEX "infra_nodes_assetId_active_key"
    ON "infra_nodes" ("assetId")
    WHERE "deletedAt" IS NULL
      AND "assetId" IS NOT NULL;
