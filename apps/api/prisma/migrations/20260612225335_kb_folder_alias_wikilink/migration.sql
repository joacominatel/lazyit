-- AlterTable
ALTER TABLE "article_categories" ADD COLUMN     "parentId" TEXT;

-- CreateTable
CREATE TABLE "article_aliases" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_wiki_links" (
    "id" TEXT NOT NULL,
    "sourceArticleId" TEXT NOT NULL,
    "targetSlug" TEXT NOT NULL,
    "resolvedTargetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_wiki_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "article_aliases_articleId_idx" ON "article_aliases"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "article_aliases_folderId_articleId_key" ON "article_aliases"("folderId", "articleId");

-- CreateIndex
CREATE INDEX "article_wiki_links_sourceArticleId_idx" ON "article_wiki_links"("sourceArticleId");

-- CreateIndex
CREATE INDEX "article_wiki_links_resolvedTargetId_idx" ON "article_wiki_links"("resolvedTargetId");

-- CreateIndex
CREATE INDEX "article_categories_parentId_idx" ON "article_categories"("parentId");

-- AddForeignKey
ALTER TABLE "article_categories" ADD CONSTRAINT "article_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "article_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_aliases" ADD CONSTRAINT "article_aliases_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "article_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_aliases" ADD CONSTRAINT "article_aliases_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_wiki_links" ADD CONSTRAINT "article_wiki_links_sourceArticleId_fkey" FOREIGN KEY ("sourceArticleId") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_wiki_links" ADD CONSTRAINT "article_wiki_links_resolvedTargetId_fkey" FOREIGN KEY ("resolvedTargetId") REFERENCES "articles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- RAW SQL Prisma cannot represent (ADR-0059 §1 / ADR-0041). Prisma neither emits nor reports the
-- folder-name PARTIAL unique index on `migrate diff` (it lives only as raw SQL, like every other
-- live-only partial unique — 20260601130000), so the drift check stays green. See
-- docs/05-runbooks/prisma-migrations.md §3.
-- ---------------------------------------------------------------------------------------------------

-- Folder-name uniqueness becomes PER PARENT among LIVE rows (ADR-0059 §1). Drop the flat live-only
-- partial unique on `name` (created in 20260601130000) and replace it with a partial unique on
-- (parentId, name) WHERE "deletedAt" IS NULL — so `Servers/Linux` and `Workstations/Linux` coexist
-- and a soft-deleted folder frees its name WITHIN ITS PARENT for reuse/restore.
--
-- NULLS NOT DISTINCT is essential here: a ROOT folder has parentId = NULL, and by default Postgres
-- treats NULLs as DISTINCT in a unique index, which would let TWO root folders both be named
-- "Servers" (no collision) — silently breaking root-level uniqueness that the old flat index enforced.
-- NULLS NOT DISTINCT (Postgres 15+) makes (NULL, 'Servers') collide with another (NULL, 'Servers'),
-- so the root level keeps single-name uniqueness exactly like the flat model, while every non-root
-- parent scopes its own children's names. The dev/prod engine is Postgres 18 (CLAUDE.md), so this is
-- available.
DROP INDEX "article_categories_name_active_key";

CREATE UNIQUE INDEX "article_categories_parent_name_active_key"
    ON "article_categories"("parentId", "name")
    NULLS NOT DISTINCT
    WHERE "deletedAt" IS NULL;
