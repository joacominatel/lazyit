"use client";

import { ChevronRightIcon, FolderIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticleBySlug } from "@/lib/api/hooks/use-articles";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import {
  articleSlugFromPath,
  isKbTreeRoute,
  kbFolderHref,
  singleCategoryId,
} from "@/lib/utils/kb-shell-route";
import { FolderTree, type FolderWithRules } from "./folder-tree";
import { KbQuickSwitcher } from "./kb-quick-switcher";

/**
 * KbShell — the PERSISTENT KB route-shell (#1106 Phase 3). Rendered by the `/kb` layout, it wraps every
 * KB child. Because App Router layouts do NOT remount on child navigation, the folder tree it owns (its
 * expand/collapse state included) survives moving between the browse list (`/kb`) and a reading page
 * (`/kb/<slug>`) with no remount and no flash — the fix for "you lose your place in the tree when you
 * open an article". This completes the 3-zone reading layout: LEFT tree (here) + reading center + right
 * Connections rail (Phase 2).
 *
 * Selection is DERIVED from the URL, never held locally, so it stays correct across navigation for free:
 *   - browse (`/kb?categoryId=…`) → the single `categoryId` filter drives the highlight;
 *   - reading (`/kb/<slug>`)      → the current article's HOME folder is highlighted (via the shared
 *     `useArticleBySlug` cache — the same key the reading page prefetches, so no extra fetch).
 * A folder pick navigates to that folder's browse list (`kbFolderHref`) via a client `router.push`, so
 * the layout (and the tree) never remounts.
 *
 * Cold deep-link: the server layout seeds `useArticleCategories` (ADR-0067), so a fresh load of
 * `/kb/<slug>` paints the tree immediately instead of flashing empty. The tree rail shows only on the
 * browse + reading routes (`isKbTreeRoute`); the focused editor surfaces (`/kb/new`, `…/edit`) stay
 * full-width. Below `lg` the rail collapses behind a "Folders" toggle.
 */
export function KbShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("kb");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  // ADR-0060: ADMIN-only access-rule editor affordance; #415: ADMIN-only folder cascade-delete.
  const canManageSettings = useCan("settings:manage");
  const canDeleteFolder = useCan("category:delete");

  const { data: categories } = useArticleCategories();

  // On a reading route, resolve the article's home folder to highlight (cache hit on the reading page's
  // prefetched by-slug read — idle/no fetch on the browse list where `slug` is null).
  const slug = articleSlugFromPath(pathname);
  const { data: article } = useArticleBySlug(slug ?? undefined);

  const showTree = isKbTreeRoute(pathname);
  const selectedFolderId = slug
    ? (article?.categoryId ?? null)
    : singleCategoryId(searchParams.get("categoryId"));

  const [mobileOpen, setMobileOpen] = useState(false);

  const search = searchParams.toString();
  const handleSelect = useCallback(
    (folderId: string | null) => {
      setMobileOpen(false);
      router.push(kbFolderHref(search, folderId));
    },
    [router, search],
  );

  // Editor surfaces (new / edit): render children full-width with no tree and no scoped ⌘K (so a
  // quick-switch can't navigate away from an in-progress draft) — the global palette still works there.
  if (!showTree) {
    return <>{children}</>;
  }

  return (
    <div>
      {/* Below lg the tree collapses behind a toggle so it never cramps the content on narrow screens. */}
      <button
        type="button"
        onClick={() => setMobileOpen((prev) => !prev)}
        aria-expanded={mobileOpen}
        className="mb-3 flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-card-foreground outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
      >
        <FolderIcon className="size-4 text-muted-foreground" aria-hidden />
        <span>{t("folders.mobileToggle")}</span>
        <ChevronRightIcon
          className={cn(
            "ml-auto size-4 text-muted-foreground transition-transform",
            mobileOpen && "rotate-90",
          )}
          aria-hidden
        />
      </button>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <aside
          className={cn(
            "lg:sticky lg:top-4 lg:block lg:w-64 lg:shrink-0",
            mobileOpen ? "block" : "hidden",
          )}
        >
          <div className="rounded-xl bg-card p-2 text-card-foreground ring-1 ring-foreground/10 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
            {categories ? (
              <FolderTree
                folders={categories as FolderWithRules[]}
                selectedFolderId={selectedFolderId}
                onSelect={handleSelect}
                isAdmin={canManageSettings}
                canDelete={canDeleteFolder}
              />
            ) : (
              <TreeSkeleton />
            )}
          </div>
        </aside>

        <div className="min-w-0 flex-1">{children}</div>
      </div>

      <KbQuickSwitcher />
    </div>
  );
}

const TREE_SKELETON_KEYS = ["a", "b", "c", "d", "e"] as const;

/** A quiet placeholder for the tree while `useArticleCategories` resolves (only on a cold, unseeded load). */
function TreeSkeleton() {
  return (
    <div className="space-y-1 p-1">
      {TREE_SKELETON_KEYS.map((key, i) => (
        <Skeleton
          key={key}
          className="h-7"
          style={{ width: `${70 - i * 6}%`, marginLeft: i % 2 === 0 ? 0 : 14 }}
        />
      ))}
    </div>
  );
}
