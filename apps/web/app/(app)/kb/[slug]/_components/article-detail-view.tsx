"use client";

import { useTranslations } from "next-intl";
import { useMemo, useRef } from "react";
import { DetailSkeleton } from "@/components/detail-panel";
import { MarkdownView } from "@/components/markdown-view";
import { ArticleAttachmentProvider } from "@/components/markdown-attachment-image-view";
import { WikiLinkProvider } from "@/components/markdown-wiki-link-view";
import { Breadcrumb, type BreadcrumbItem } from "@/components/breadcrumb";
import { ErrorState } from "@/components/resource-table";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticleBySlug } from "@/lib/api/hooks/use-articles";
import { useWikiLinkResolver } from "@/lib/api/hooks/use-wiki-link-resolver";
import { useCan } from "@/lib/hooks/use-permissions";
import { articleFolderTrail } from "@/lib/utils/kb-reading";
import { ArticleConnectionsRail } from "./article-connections-rail";
import { ArticleCoversRow } from "./article-covers-row";
import { ArticleLedgerHeader } from "./article-ledger-header";
import { ArticleSiblingFooter } from "./article-sibling-footer";
import { ArticleToc, ArticleTocDetails, useTocHeadings } from "./article-toc";
import { ArticleWikiLinkPreviewProvider } from "./article-wiki-link-preview";

/**
 * The calm KB reading view (#1106 Phase 2). A comfortable single reading column with a right rail on
 * `xl+` — no left folder tree yet (that's Phase 3). Won as much by DELETION as addition: the old
 * metadata-dense PageHeader, the four always-on stacked panels and the excerpt blockquote are gone.
 *
 * What renders:
 *  - a FULL folder-path breadcrumb (Knowledge Base › … › home folder › title);
 *  - a slim LEDGER RECORD HEADER (title + one Commit-Mono record line; edit/⋯ cluster);
 *  - a "Covers" chip row (only when the article links assets/apps);
 *  - the excerpt as a quiet muted lede (no blockquote);
 *  - the Phase-1 markdown, with a hover Quick View on resolved `[[wiki-links]]`;
 *  - a prev/next sibling footer;
 *  - a sticky "On this page" TOC + a "Connections" rail (xl rail; TOC collapses to a `<details>` and
 *    Connections stacks below the prose under xl). Each rail section shows only when it has content.
 */
export function ArticleDetailView({ slug }: { slug: string }) {
  const t = useTranslations("kb");

  const {
    data: article,
    isLoading,
    isError,
    error,
    refetch,
  } = useArticleBySlug(slug);
  const { data: categories } = useArticleCategories();
  // Edit / Publish / Unpublish / link are article:write; deletion is article:delete. The API also
  // enforces authorship — the permission is the coarse gate, authorship the finer server-side one.
  const canWrite = useCan("article:write");
  const canDelete = useCan("article:delete");
  // Render-time `[[slug]]` resolver (ADR-0059 §3): resolved → KB link, unresolved → tooltip.
  const resolveWikiLink = useWikiLinkResolver();

  // "On this page" TOC + scroll-spy, read from the rendered prose DOM (Phase-1 heading ids).
  const proseRef = useRef<HTMLDivElement>(null);
  const { headings, activeId } = useTocHeadings(proseRef, article?.content ?? "");

  // Full folder-path breadcrumb: Knowledge Base › ‹root…home folders› › article title.
  const breadcrumbItems = useMemo<BreadcrumbItem[]>(() => {
    const items: BreadcrumbItem[] = [{ label: t("breadcrumb"), href: "/kb" }];
    for (const folder of articleFolderTrail(article?.categoryId, categories ?? [])) {
      items.push({
        label: folder.name,
        href: `/kb?categoryId=${encodeURIComponent(folder.id)}`,
      });
    }
    items.push({ label: article?.title ?? "" });
    return items;
  }, [t, article?.categoryId, article?.title, categories]);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl">
        <DetailSkeleton panels={1} />
      </div>
    );
  }

  if (isError || !article) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <Breadcrumb items={breadcrumbItems} />

      <div className="mt-4 flex flex-col gap-x-10 gap-y-8 xl:flex-row xl:items-start">
        {/* Reading column — a comfortable measure. */}
        <div className="min-w-0 flex-1 space-y-6 xl:max-w-3xl">
          <ArticleLedgerHeader
            article={article}
            canWrite={canWrite}
            canDelete={canDelete}
          />

          <ArticleCoversRow articleId={article.id} />

          {/* Below xl: the TOC collapses to a disclosure above the prose. */}
          <ArticleTocDetails
            headings={headings}
            activeId={activeId}
            className="xl:hidden"
          />

          {article.excerpt ? (
            <p className="text-base leading-relaxed text-pretty text-muted-foreground">
              {article.excerpt}
            </p>
          ) : null}

          <WikiLinkProvider resolve={resolveWikiLink}>
            <ArticleWikiLinkPreviewProvider>
              <ArticleAttachmentProvider articleId={article.id}>
                <div ref={proseRef}>
                  <MarkdownView content={article.content} />
                </div>
              </ArticleAttachmentProvider>
            </ArticleWikiLinkPreviewProvider>
          </WikiLinkProvider>

          <ArticleSiblingFooter
            articleId={article.id}
            homeFolderId={article.categoryId}
          />
        </div>

        {/* Right rail — sticky TOC + Connections on xl; below xl it stacks under the prose (the xl-only
            TOC is hidden there, so only Connections shows, and it lands below the article). */}
        <aside className="xl:w-72 xl:shrink-0">
          <div className="space-y-6 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto xl:pb-4">
            <ArticleToc
              headings={headings}
              activeId={activeId}
              className="hidden xl:block"
            />
            <ArticleConnectionsRail
              articleId={article.id}
              homeFolderId={article.categoryId}
              canWrite={canWrite}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
