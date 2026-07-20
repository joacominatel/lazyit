"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WikiLinkPreviewProvider,
  type WikiLinkPreviewRenderer,
} from "@/components/markdown-wiki-link-view";
import { QuickViewPopover } from "@/components/quick-view-popover";
import type { QuickViewData } from "@/components/quick-view-fields";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticles } from "@/lib/api/hooks/use-articles";

/**
 * KB-only hover preview for RESOLVED `[[wiki-links]]` (#1106 Phase 2). Wraps the article prose in a
 * {@link WikiLinkPreviewProvider}: each resolved link gains a hover {@link QuickViewPopover}
 * (entity `article`) so a reader can peek the target — title, status, folder, excerpt — WITHOUT
 * leaving the page. Unresolved links (the "not created yet" tooltip) are untouched.
 *
 * Zero extra fetch: the slug→preview map is built from the SAME wide article page the
 * `useWikiLinkResolver` already loads (identical query key → shared React Query cache) plus the folder
 * list already loaded for the breadcrumb. A slug with no loaded row simply renders the plain link.
 */

// Mirrors `useWikiLinkResolver`'s page so the query key (and cache) is identical — no second request.
const RESOLVER_FILTERS = { limit: 200, offset: 0 } as const;
// Hover intent: long enough that skimming prose doesn't flash previews, short enough to feel instant.
const HOVER_INTENT_MS = 140;

export function ArticleWikiLinkPreviewProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { data: page } = useArticles(RESOLVER_FILTERS);
  const { data: categories } = useArticleCategories();

  const bySlug = useMemo(() => {
    const categoryName = new Map(
      (categories ?? []).map((category) => [category.id, category.name]),
    );
    const map = new Map<string, QuickViewData>();
    for (const article of page?.items ?? []) {
      map.set(article.slug, {
        entity: "article",
        data: {
          id: article.id,
          title: article.title,
          slug: article.slug,
          status: article.status,
          categoryName: categoryName.get(article.categoryId) ?? null,
          excerpt: article.excerpt,
        },
      });
    }
    return map;
  }, [page, categories]);

  const render = useCallback<WikiLinkPreviewRenderer>(
    (slug, link) => {
      const view = bySlug.get(slug);
      return view ? (
        <WikiLinkQuickView view={view}>{link}</WikiLinkQuickView>
      ) : (
        link
      );
    },
    [bySlug],
  );

  return (
    <WikiLinkPreviewProvider render={render}>
      {children}
    </WikiLinkPreviewProvider>
  );
}

/**
 * One resolved wiki-link wrapped in a hover-only Quick View. The link stays a real, keyboard-navigable
 * `next/link`; an inline `<span>` around it is the popover anchor and owns the hover-intent timer. The
 * preview is never pinned (a peek, not a dialog) — it opens on a deliberate hover and dismisses on
 * leave or Escape, so it never steals focus from the reading flow.
 */
function WikiLinkQuickView({
  view,
  children,
}: {
  view: QuickViewData;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // Cancel a pending open if the link unmounts (or the prose re-renders) mid-hover.
  useEffect(() => clearTimer, []);

  return (
    <QuickViewPopover
      view={view}
      open={open}
      pinned={false}
      onOpenChange={(next) => {
        // Radix drives this on Escape / outside-click — collapse our state to match.
        if (!next) {
          clearTimer();
          setOpen(false);
        }
      }}
      anchor={
        <span
          onMouseEnter={() => {
            clearTimer();
            timer.current = setTimeout(() => setOpen(true), HOVER_INTENT_MS);
          }}
          onMouseLeave={() => {
            clearTimer();
            setOpen(false);
          }}
        >
          {children}
        </span>
      }
    />
  );
}
