"use client";

import { useTranslations } from "next-intl";
import { ArticleAliasesPanel } from "@/app/(app)/kb/_components/article-aliases-panel";
import { ArticleLinksPanel } from "@/app/(app)/kb/_components/article-links-panel";
import { ArticleReferencesPanel } from "@/app/(app)/kb/_components/article-references-panel";
import { useArticleLinks } from "@/lib/api/hooks/use-article-links";
import {
  useArticleAliases,
  useArticleBacklinks,
} from "@/lib/api/hooks/use-article-wiki-links";
import { cn } from "@/lib/utils";

/**
 * The KB "Connections" rail (#1106 Phase 2) — the four always-on stacked panels of the old detail view
 * DISSOLVED into ONE calm side rail, each section shown ONLY WHEN IT HAS SOMETHING TO SAY:
 *
 *   - "Referenced by (N)"  — article↔article backlinks (ADR-0059 §4). Read-only → shown only when N>0.
 *   - "Linked to"          — asset/application links (ADR-0042). Holds the add/remove WRITE surface.
 *   - "Also in"            — nav-only folder aliases (ADR-0059 §2). Also holds a write surface.
 *
 * Version History is NOT here — it lives behind the header's "⋯" menu. An article with NO connections
 * renders NOTHING (the whole rail returns null) for a READER, so the reading page is just prose. The
 * two write-surface sections ("Linked to" / "Also in") stay visible to an AUTHOR even when empty, since
 * they host the "+ Add" affordances — a reader never sees an empty panel.
 *
 * Gating reads the same three hooks the panels use (deduped by React Query — zero extra fetch).
 */
export function ArticleConnectionsRail({
  articleId,
  homeFolderId,
  canWrite,
  className,
}: {
  articleId: string;
  /** The article's home folder (`categoryId`) — the alias panel excludes it as a target. */
  homeFolderId: string;
  canWrite: boolean;
  className?: string;
}) {
  const t = useTranslations("kb");
  const { data: backlinks } = useArticleBacklinks(articleId);
  const { data: links } = useArticleLinks(articleId);
  const { data: aliases } = useArticleAliases(articleId);

  const backlinkCount = backlinks?.length ?? 0;
  const hasLinks = (links?.length ?? 0) > 0;
  const hasAliases = (aliases?.length ?? 0) > 0;

  const showReferences = backlinkCount > 0;
  const showLinks = hasLinks || canWrite;
  const showAliases = hasAliases || canWrite;

  if (!showReferences && !showLinks && !showAliases) return null;

  return (
    <section
      aria-label={t("connections.railLabel")}
      className={cn("space-y-4", className)}
    >
      {showReferences ? (
        <ArticleReferencesPanel
          articleId={articleId}
          title={t("connections.referencedBy", { count: backlinkCount })}
        />
      ) : null}
      {showLinks ? (
        <ArticleLinksPanel articleId={articleId} canWrite={canWrite} />
      ) : null}
      {showAliases ? (
        <ArticleAliasesPanel
          articleId={articleId}
          homeFolderId={homeFolderId}
          canWrite={canWrite}
        />
      ) : null}
    </section>
  );
}
