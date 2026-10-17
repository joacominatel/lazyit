"use client";

import type { Folder } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import {
  compareFolderOrder,
  folderPathLabel,
  restrictedAncestorOf,
} from "@/lib/utils/folder-tree";
import { restrictedFolderIdSet } from "@/lib/utils/kb-folder-access";
import type { FolderDisplay, FolderRestriction } from "../_components/article-table";
import type { FolderWithRules } from "../_components/folder-tree";

/**
 * One memoised index over the live folder list for the KB browse surfaces (#1539): lookups by id, the
 * direct children of each folder, and how a folder reads in a row (its full path and its padlock —
 * own rule, inherited from an ancestor, or public). Presentation only; the API enforces access.
 */
export function useFolderIndex() {
  const t = useTranslations("kb");
  const { data } = useArticleCategories();
  const folders = useMemo(() => (data ?? []) as FolderWithRules[], [data]);

  const folderById = useMemo(
    () => new Map<string, FolderWithRules>(folders.map((f) => [f.id, f])),
    [folders],
  );
  const parentById = useMemo(
    () => new Map(folders.map((f) => [f.id, f.parentId ?? null])),
    [folders],
  );
  const restrictedIds = useMemo(() => restrictedFolderIdSet(folders), [folders]);
  const childrenById = useMemo(() => {
    const map = new Map<string, FolderWithRules[]>();
    for (const folder of folders) {
      if (!folder.parentId || !folderById.has(folder.parentId)) continue;
      const list = map.get(folder.parentId) ?? [];
      list.push(folder);
      map.set(folder.parentId, list);
    }
    for (const list of map.values()) list.sort(compareFolderOrder);
    return map;
  }, [folders, folderById]);
  const roots = useMemo(
    () =>
      folders
        .filter((f) => !f.parentId || !folderById.has(f.parentId))
        .toSorted(compareFolderOrder),
    [folders, folderById],
  );

  const restrictionOf = useCallback(
    (folderId: string): { restriction: FolderRestriction; ancestorName?: string } => {
      if (restrictedIds.has(folderId)) return { restriction: "own" };
      const ancestorId = restrictedAncestorOf(folderId, parentById, restrictedIds);
      if (ancestorId) {
        return {
          restriction: "inherited",
          ancestorName: folderById.get(ancestorId)?.name ?? "",
        };
      }
      return { restriction: "public" };
    },
    [restrictedIds, parentById, folderById],
  );

  const folderOf = useCallback(
    (categoryId: string): FolderDisplay => {
      const folder = folderById.get(categoryId);
      if (!folder) return { path: t("list.uncategorized"), restriction: "public" };
      return {
        path: folderPathLabel(folder as Folder, folderById as Map<string, Folder>),
        ...restrictionOf(categoryId),
      };
    },
    [folderById, restrictionOf, t],
  );

  return {
    folders,
    loaded: data !== undefined,
    folderById,
    childrenById,
    roots,
    restrictionOf,
    folderOf,
  };
}

export type FolderIndex = ReturnType<typeof useFolderIndex>;
