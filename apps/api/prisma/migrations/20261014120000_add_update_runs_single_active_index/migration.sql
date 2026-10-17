-- Existing duplicates would block the index: keep the run most likely executing now (this runs inside update.sh), fail the rest.
WITH ranked AS (
    SELECT "id",
           ROW_NUMBER() OVER (
               ORDER BY ("status" <> 'requested') DESC,
                        "startedAt" DESC NULLS LAST,
                        "createdAt" DESC,
                        "id" DESC
           ) AS rn
    FROM "update_runs"
    WHERE "status" NOT IN ('done', 'failed', 'rolled_back')
)
UPDATE "update_runs" AS u
SET "status"     = 'failed',
    "finishedAt" = COALESCE(u."finishedAt", CURRENT_TIMESTAMP),
    "error"      = concat_ws(' ', u."error", 'Superseded: another update run was already active when the one-active-run constraint was added.'),
    "updatedAt"  = CURRENT_TIMESTAMP
FROM ranked
WHERE u."id" = ranked."id"
  AND ranked.rn > 1;

-- Keyed on the terminal set so a new in-flight phase is covered without another migration.
CREATE UNIQUE INDEX "update_runs_single_active_key"
    ON "update_runs" ((true))
    WHERE "status" NOT IN ('done', 'failed', 'rolled_back');
