-- Article reading metric (ADR-0042): a MAINTAINED `readingMinutes` column on `articles`, so the lean
-- list (GET /articles — content omitted for performance) can ship an estimated reading time for the
-- KB card UI WITHOUT loading the markdown body. The service recomputes it on every write that touches
-- `content` (create/import/edit); this migration adds the column and backfills existing rows from the
-- current body. Formula: ~200 words/minute, min 1 minute for any non-empty body, 0 for an empty one —
-- identical to the service's `readingMinutesOf(content)`. See docs/02-domain/entities/article.md.

-- AlterTable: additive, non-null with a default so the column is valid for every existing row before
-- the backfill runs (and for any insert that predates the app-level maintenance).
ALTER TABLE "articles" ADD COLUMN "readingMinutes" INTEGER NOT NULL DEFAULT 0;

-- Backfill from the existing markdown body. `regexp_split_to_array(trim(content), '\s+')` splits on
-- whitespace runs into word tokens; an empty/whitespace-only body trims to '' and yields a single
-- empty token, so we guard it with a `trim(content) = ''` test → 0 minutes. Otherwise the reading
-- time is GREATEST(1, ceil(words / 200.0)).
UPDATE "articles"
SET "readingMinutes" = CASE
  WHEN btrim("content") = '' THEN 0
  ELSE GREATEST(
    1,
    CEIL(
      array_length(regexp_split_to_array(btrim("content"), '\s+'), 1)::numeric / 200.0
    )::integer
  )
END;
