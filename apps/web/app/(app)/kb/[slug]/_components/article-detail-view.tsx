"use client";

import { useTranslations } from "next-intl";
import { useMemo, useRef } from "react";
import { DetailSkeleton } from "@/components/detail-panel";
import { MarkdownView } from "@/components/markdown-view";
import { ArticleAttachmentProvider } from "@/components/markdown-attachment-image-view";
import {
  WikiLinkCreateProvider,
  WikiLinkProvider,
} from "@/components/markdown-wiki-link-view";
import { Breadcrumb, type BreadcrumbItem } from "@/components/breadcrumb";
import { ErrorState } from "@/components/resource-table";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticleBySlug } from "@/lib/api/hooks/use-articles";
import { useWikiLinkResolver } from "@/lib/api/hooks/use-wiki-link-resolver";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import {
  READING_CONTAINER,
  READING_RAIL,
  READING_RAIL_STICKY,
  READING_ROW,
  TOC_RAIL_ONLY,
  TOC_STACKED_ONLY,
} from "@/lib/utils/kb-reading-layout";
import { articleFolderTrail } from "@/lib/utils/kb-reading";
import { buildKbCreateHref } from "@/lib/utils/kb-wiki-link-prefill";
import { ArticleConnectionsRail } from "./article-connections-rail";
import { ArticleCoversRow } from "./article-covers-row";
import { ArticleLedgerHeader } from "./article-ledger-header";
import { ArticleSiblingFooter } from "./article-sibling-footer";
import { ArticleToc, ArticleTocDetails, useTocHeadings } from "./article-toc";
import { ArticleWikiLinkPreviewProvider } from "./article-wiki-link-preview";

/**
 * The calm KB reading view (#1106 Phase 2). A comfortable single reading column with a right rail once
 * three columns actually fit. Won as much by DELETION as addition: the old metadata-dense PageHeader,
 * the four always-on stacked panels and the excerpt blockquote are gone.
 *
 * What renders:
 *  - a FULL folder-path breadcrumb (Knowledge Base › … › home folder › title);
 *  - a slim LEDGER RECORD HEADER (title + one Commit-Mono record line; edit/⋯ cluster);
 *  - a "Covers" chip row (only when the article links assets/apps);
 *  - the excerpt as a quiet muted lede (no blockquote);
 *  - the Phase-1 markdown, with a hover Quick View on resolved `[[wiki-links]]`;
 *  - a prev/next sibling footer;
 *  - a sticky "On this page" TOC + a "Connections" rail (rail from `RAIL_MIN_VIEWPORT`; below that
 *    the TOC collapses to a `<details>` above the prose and Connections stacks below it). Each rail
 *    section shows only when it has content.
 *
 * WIDTH BUDGET (#1292). Chrome outside this view costs a fixed 568px at `md`+ with the folder tree
 * showing: the app sidebar (`w-60`), the main padding (`md:p-6`, 48px) and the KB folder rail
 * (`lg:w-64` + `gap-6`, 280px). The three-column split costs another 328px (`gap-x-10` + `w-72`).
 * Splitting at `xl` (1280px) therefore left ~544px of prose at 1440px — the `max-w-3xl` cap never
 * engaged — while `max-w-6xl` capped the block ~200px short of the space available at 1920px.
 *
 * So the split is gated on the width where it actually fits rather than on a stock breakpoint:
 * READING_MEASURE (872px) + 328px + 568px = 1768px, rounded to 1800px. Below it the rail stacks and
 * the prose takes the full column up to READING_MEASURE; above it the block caps at exactly
 * READING_MEASURE + 328px, so prose, gap and rail tile the container with nothing dead between them.
 * The measure is continuous across the breakpoint — 872px on either side of 1800px.
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
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={1} />
      </div>
    );
  }

  if (isError || !article) {
    return (
      <div className="mx-auto max-w-4xl">
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
    <div className={cn("mx-auto w-full", READING_CONTAINER)}>
      <Breadcrumb items={breadcrumbItems} />

      <div className={cn("mt-4 flex flex-col gap-x-10 gap-y-8", READING_ROW)}>
        {/* Reading column — takes the whole container below the rail breakpoint, and exactly
            READING_MEASURE above it (the container is sized so nothing is left over). */}
        <div className="min-w-0 flex-1 space-y-6">
          <ArticleLedgerHeader
            article={article}
            canWrite={canWrite}
            canDelete={canDelete}
          />

          <ArticleCoversRow articleId={article.id} />

          {/* Below the rail breakpoint: the TOC collapses to a disclosure above the prose. */}
          <ArticleTocDetails
            headings={headings}
            activeId={activeId}
            className={TOC_STACKED_ONLY}
          />

          {article.excerpt ? (
            <p className="text-base leading-relaxed text-pretty text-muted-foreground">
              {article.excerpt}
            </p>
          ) : null}

          {/* #1106 Phase 4: a writer (`article:write`) turns unresolved `[[slug]]`s into "create this
              note" links (→ /kb/new prefilled); a reader gets `null` → the calm inert tooltip stays. */}
          <WikiLinkProvider resolve={resolveWikiLink}>
            <WikiLinkCreateProvider build={canWrite ? buildKbCreateHref : null}>
              <ArticleWikiLinkPreviewProvider>
                <ArticleAttachmentProvider articleId={article.id}>
                  <div ref={proseRef}>
                    <MarkdownView content={article.content} />
                  </div>
                </ArticleAttachmentProvider>
              </ArticleWikiLinkPreviewProvider>
            </WikiLinkCreateProvider>
          </WikiLinkProvider>

          <ArticleSiblingFooter
            articleId={article.id}
            homeFolderId={article.categoryId}
          />
        </div>

        {/* Right rail — sticky TOC + Connections once three columns fit; below that it stacks under
            the prose (the rail-only TOC is hidden there, so only Connections shows, and it lands
            below the article — the disclosure above the prose carries the TOC instead). */}
        <aside className={READING_RAIL}>
          <div className={cn("space-y-6", READING_RAIL_STICKY)}>
            <ArticleToc
              headings={headings}
              activeId={activeId}
              className={TOC_RAIL_ONLY}
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
