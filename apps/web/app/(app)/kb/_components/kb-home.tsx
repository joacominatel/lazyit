"use client";

import { BookOpenIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { useArticleStatusCounts } from "@/lib/api/hooks/use-articles";
import { useCan } from "@/lib/hooks/use-permissions";
import { rankFolderCards } from "@/lib/utils/kb-folder-rank";
import { kbFolderHref } from "@/lib/utils/kb-shell-route";
import type { FolderIndex } from "../_lib/use-folder-index";
import { KbCreateActions } from "./kb-browse-controls";
import { FolderFormDialog } from "./folder-form-dialog";
import { FolderTile } from "./folder-tile";
import { RestrictionPadlock } from "./restriction-padlock";

/** Mono, tabular number inside a translated stats sentence. */
const num = (chunks: ReactNode) => (
  <span className="font-mono text-foreground tabular-nums">{chunks}</span>
);

/**
 * The KB home header (#1539): title, ONE stats line (articles · published · your drafts · folders) and
 * the create actions. The stats come from the same cheap `limit: 1` reads the rail uses (shared cache
 * keys), plus the folder list the layout already prefetched; each figure appears once it resolves.
 */
export function KbHomeHeader({ folderCount }: { folderCount: number }) {
  const t = useTranslations("kb");
  const counts = useArticleStatusCounts();
  const stats: ReactNode[] = [];
  if (counts.all !== undefined) stats.push(t.rich("home.stats.articles", { count: counts.all, n: num }));
  if (counts.published !== undefined)
    stats.push(t.rich("home.stats.published", { count: counts.published, n: num }));
  if (counts.drafts !== undefined) stats.push(t.rich("home.stats.drafts", { count: counts.drafts, n: num }));
  stats.push(t.rich("home.stats.folders", { count: folderCount, n: num }));

  return (
    <PageHeader
      title={t("list.title")}
      pillar="knowledge"
      icon={BookOpenIcon}
      subtitle={
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
          {stats.map((stat, i) => (
            // A fixed-order list of up to four sentences; the index is a stable key here.
            <span key={i}>{stat}</span>
          ))}
        </span>
      }
      actions={<KbCreateActions />}
    />
  );
}

/** Root folders shown before "See all" — one or two rows of cards. */
const CARD_LIMIT = 6;

/**
 * The home page's "Folders" grid (#1539): one card per ROOT folder — colour tile, name, description
 * (two-line clamp), article and sub-folder counts, and "Restricted" when it is — plus a dashed "New
 * folder" card for `category:write` holders. Long lists collapse behind "See all (N)".
 */
export function KbFolderCards({ index }: { index: FolderIndex }) {
  const t = useTranslations("kb");
  const search = useSearchParams().toString();
  const router = useRouter();
  const canWrite = useCan("category:write");
  const [showAll, setShowAll] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { roots, childrenById, restrictionOf } = index;
  const limit = canWrite ? CARD_LIMIT - 1 : CARD_LIMIT;
  // The fullest branches first, so the few cards before "See all" are the folders that hold knowledge.
  const ranked = useMemo(() => rankFolderCards(roots, childrenById), [roots, childrenById]);
  const visible = showAll ? ranked : ranked.slice(0, limit);

  if (roots.length === 0 && !canWrite) return null;

  return (
    <section aria-labelledby="kb-home-folders" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2
          id="kb-home-folders"
          className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {t("home.foldersTitle")}
        </h2>
        {roots.length > limit ? (
          <button
            type="button"
            onClick={() => setShowAll((prev) => !prev)}
            aria-expanded={showAll}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showAll ? t("home.showFewer") : t("home.showAll", { count: roots.length })}
          </button>
        ) : null}
      </div>

      <ul className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {visible.map((folder) => {
          const { restriction, ancestorName } = restrictionOf(folder.id);
          const subfolders = childrenById.get(folder.id)?.length ?? 0;
          return (
            <li key={folder.id} className="min-w-0">
              <Link
                href={kbFolderHref(search, folder.id)}
                className="flex h-full flex-col gap-2 rounded-xl bg-card p-3 text-card-foreground sm:p-4 ring-1 ring-foreground/10 outline-none transition-colors hover:bg-accent/30 hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <FolderTile folderId={folder.id} size="sm" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{folder.name}</span>
                  {restriction !== "public" ? (
                    <RestrictionPadlock
                      inheritedFrom={restriction === "inherited" ? (ancestorName ?? "") : null}
                    />
                  ) : null}
                </span>
                {folder.description ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {folder.description}
                  </span>
                ) : null}
                <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-1 text-xs text-muted-foreground">
                  {folder.articleCount != null ? (
                    <span>{t.rich("home.card.articles", { count: folder.articleCount, n: num })}</span>
                  ) : null}
                  {subfolders > 0 ? (
                    <span>{t.rich("home.card.subfolders", { count: subfolders, n: num })}</span>
                  ) : null}
                  {restriction !== "public" ? (
                    <span className="font-medium text-warning-text">{t("access.stateRestricted")}</span>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
        {canWrite ? (
          <li className="min-w-0">
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex h-full min-h-24 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PlusIcon className="size-4" aria-hidden />
              {t("folders.form.newRoot")}
            </button>
          </li>
        ) : null}
      </ul>

      {createOpen ? (
        <FolderFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          mode="create"
          parentId={null}
          onCreated={(id) => router.push(kbFolderHref(search, id))}
        />
      ) : null}
    </section>
  );
}
