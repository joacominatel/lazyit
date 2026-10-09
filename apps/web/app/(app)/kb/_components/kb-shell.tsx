"use client";

import {
  ChevronRightIcon,
  ClockIcon,
  FolderIcon,
  LinkIcon,
  PencilSquareIcon,
  PlusIcon,
  RectangleStackIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ComponentType, useCallback, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import {
  useArticleBySlug,
  useArticles,
  useArticleStatusCounts,
} from "@/lib/api/hooks/use-articles";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { kbActiveView, type KbView, kbViewHref } from "@/lib/utils/kb-browse";
import {
  articleSlugFromPath,
  isKbTreeRoute,
  kbFolderHref,
  singleCategoryId,
} from "@/lib/utils/kb-shell-route";
import type { FolderPermissions } from "./folder-actions-menu";
import { FolderFormDialog } from "./folder-form-dialog";
import { FolderTree, type FolderWithRules } from "./folder-tree";
import { KbQuickSwitcher } from "./kb-quick-switcher";

/**
 * KbShell — the PERSISTENT KB route-shell (#1106 Phase 3, rail redesigned in #1539). Rendered by the
 * `/kb` layout, it wraps every KB child. Because App Router layouts do NOT remount on child navigation,
 * the rail it owns (the folder tree's expand state included) survives moving between the browse page
 * (`/kb`) and a reading page (`/kb/<slug>`) with no remount and no flash.
 *
 * The rail (`lg:w-72`) has two sections:
 *  - **Views** — All articles, My drafts (`status=DRAFT`; drafts are private to their author), Recent
 *    (this browser's recently opened list) and Linked (`linked=only`), with counts from cheap
 *    `limit: 1` reads. The active view is DERIVED from the URL (`kbActiveView`), never held locally.
 *  - **Folders** — a header with a small "+" (new root folder, `category:write`) over the tree.
 *
 * Selection is DERIVED from the URL too: on browse the single `categoryId` drives the highlight; on a
 * reading page the article's HOME folder is highlighted (via the shared `useArticleBySlug` cache — the
 * key the reading page prefetches, so no extra fetch). Picks navigate with a client `router.push`, so
 * the layout never remounts.
 *
 * Cold deep-link: the server layout seeds `useArticleCategories` (ADR-0067), so a fresh load paints the
 * tree immediately. The rail shows only on the browse + reading routes (`isKbTreeRoute`); the editor
 * surfaces (`/kb/new`, `…/edit`) stay full-width. Below `lg` the rail collapses behind a toggle.
 */
export function KbShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("kb");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  // ADR-0060: ADMIN-only access-rule editor; #415: folder cascade-delete; #1291: create / edit / move,
  // on the same gates the API enforces.
  const perms: FolderPermissions = {
    isAdmin: useCan("settings:manage"),
    canWrite: useCan("category:write"),
    canDelete: useCan("category:delete"),
  };

  const { data: categories } = useArticleCategories();

  // On a reading route, resolve the article's home folder to highlight (cache hit on the reading page's
  // prefetched by-slug read — idle/no fetch on the browse list where `slug` is null).
  const slug = articleSlugFromPath(pathname);
  const { data: article } = useArticleBySlug(slug ?? undefined);

  const showTree = isKbTreeRoute(pathname);
  const selectedFolderId = slug
    ? (article?.categoryId ?? null)
    : singleCategoryId(searchParams.get("categoryId"));
  const activeView = slug ? null : kbActiveView(searchParams);

  const [mobileOpen, setMobileOpen] = useState(false);
  const [newRootOpen, setNewRootOpen] = useState(false);

  const search = searchParams.toString();
  const handleSelect = useCallback(
    (folderId: string | null) => {
      setMobileOpen(false);
      router.push(kbFolderHref(search, folderId));
    },
    [router, search],
  );

  // Editor surfaces (new / edit): render children full-width with no rail and no scoped ⌘K (so a
  // quick-switch can't navigate away from an in-progress draft) — the global palette still works there.
  if (!showTree) {
    return <>{children}</>;
  }

  return (
    <div>
      {/* Below lg the rail collapses behind a toggle so it never cramps the content on narrow screens. */}
      <button
        type="button"
        onClick={() => setMobileOpen((prev) => !prev)}
        aria-expanded={mobileOpen}
        className="mb-3 flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-card-foreground outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
      >
        <FolderIcon className="size-4 text-muted-foreground" aria-hidden />
        <span>{t("rail.mobileToggle")}</span>
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
            "lg:sticky lg:top-4 lg:block lg:w-72 lg:shrink-0",
            mobileOpen ? "block" : "hidden",
          )}
        >
          <div className="space-y-4 rounded-xl bg-card p-2 text-card-foreground ring-1 ring-foreground/10 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
            <RailViews
              activeView={activeView}
              onNavigate={() => setMobileOpen(false)}
            />

            <section aria-labelledby="kb-rail-folders">
              <div className="flex items-center justify-between px-2 pb-1">
                <h2
                  id="kb-rail-folders"
                  className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                >
                  {t("rail.folders")}
                </h2>
                {perms.canWrite ? (
                  <button
                    type="button"
                    onClick={() => setNewRootOpen(true)}
                    aria-label={t("folders.form.newRoot")}
                    title={t("folders.form.newRoot")}
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <PlusIcon className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>
              {categories ? (
                <FolderTree
                  folders={categories as FolderWithRules[]}
                  selectedFolderId={selectedFolderId}
                  onSelect={handleSelect}
                  perms={perms}
                />
              ) : (
                <TreeSkeleton />
              )}
            </section>
          </div>
        </aside>

        <div className="min-w-0 flex-1">{children}</div>
      </div>

      {newRootOpen ? (
        <FolderFormDialog
          open={newRootOpen}
          onOpenChange={setNewRootOpen}
          mode="create"
          parentId={null}
          onCreated={(id) => handleSelect(id)}
        />
      ) : null}

      <KbQuickSwitcher />
    </div>
  );
}

const VIEW_ICON: Record<KbView, ComponentType<{ className?: string }>> = {
  all: RectangleStackIcon,
  drafts: PencilSquareIcon,
  recent: ClockIcon,
  linked: LinkIcon,
};

const VIEW_ORDER: readonly KbView[] = ["all", "drafts", "recent", "linked"];

/**
 * The rail's Views. Counts come from `limit: 1` reads: All = published + drafts (the two statuses
 * partition what the viewer can see), My drafts = the drafts total, Linked = the `linked=only` total.
 * Recent has no count — it is this browser's list, not a server total. A count that has not resolved
 * (or failed) is simply not shown.
 */
function RailViews({
  activeView,
  onNavigate,
}: {
  activeView: KbView | null;
  onNavigate: () => void;
}) {
  const t = useTranslations("kb");
  const counts = useArticleStatusCounts();
  const { data: linkedPage } = useArticles({ linked: "only", limit: 1 });

  const countFor: Record<KbView, number | undefined> = {
    all: counts.all,
    drafts: counts.drafts,
    recent: undefined,
    linked: linkedPage?.total,
  };

  return (
    <nav aria-labelledby="kb-rail-views">
      <h2
        id="kb-rail-views"
        className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
      >
        {t("rail.views")}
      </h2>
      <ul className="space-y-px text-sm">
        {VIEW_ORDER.map((view) => {
          const Icon = VIEW_ICON[view];
          const active = activeView === view;
          const count = countFor[view];
          return (
            <li key={view}>
              <Link
                href={kbViewHref(view)}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-accent/70 font-medium text-foreground hover:bg-accent/70",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t(`rail.view.${view}`)}</span>
                {count !== undefined ? (
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
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
