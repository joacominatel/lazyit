-- CreateTable
CREATE TABLE "article_versions" (
    "id" SERIAL NOT NULL,
    "articleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "excerpt" TEXT,
    "status" "ArticleStatus" NOT NULL,
    "editedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_links" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "assetId" TEXT,
    "applicationId" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "article_versions_articleId_version_key" ON "article_versions"("articleId", "version");

-- CreateIndex
CREATE INDEX "article_links_articleId_idx" ON "article_links"("articleId");

-- CreateIndex
CREATE INDEX "article_links_assetId_idx" ON "article_links"("assetId");

-- CreateIndex
CREATE INDEX "article_links_applicationId_idx" ON "article_links"("applicationId");

-- AddForeignKey
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- Article-versioning + linking constraints Prisma cannot express in PSL (raw SQL — invisible to
-- `migrate diff`, so the drift check stays green). See ADR-0042 and docs/05-runbooks/prisma-migrations.md §3.
-- ---------------------------------------------------------------------------------------------------

-- EXACTLY-ONE-TARGET (ADR-0042): an ArticleLink points at an Asset XOR an Application — never both,
-- never neither. Counting the non-null targets must equal 1. This is the DB-level guarantee behind
-- the service-level validation, so a malformed link can never be persisted.
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_exactly_one_target"
  CHECK ((("assetId" IS NOT NULL)::int + ("applicationId" IS NOT NULL)::int) = 1);

-- DUPLICATE-LINK PREVENTION (ADR-0042): at most one link per (article, target). Two PARTIAL unique
-- indexes (one per target, scoped to rows where that target is set) — a single composite unique over
-- (articleId, assetId, applicationId) wouldn't work because NULLs are distinct in Postgres. Prisma
-- can't express partial uniques in PSL, mirroring the AssetAssignment / soft-delete precedent.
CREATE UNIQUE INDEX "article_links_article_asset_key"
  ON "article_links" ("articleId", "assetId") WHERE "assetId" IS NOT NULL;
CREATE UNIQUE INDEX "article_links_article_application_key"
  ON "article_links" ("articleId", "applicationId") WHERE "applicationId" IS NOT NULL;
