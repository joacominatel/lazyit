"use client";

import { FolderIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";

/**
 * FolderBrowseCard — an enterable child-folder card shown in the KB main content area (#413). When
 * the selected folder has sub-folders, they appear as these cards above the article grid so you can
 * drill DOWN from the content area like a file explorer (not only via the left tree). Clicking the
 * card enters the folder: it selects it in the tree and updates the URL `categoryId` filter (the
 * page's `onSelect`), so the grid re-filters to that folder's articles + its own children.
 *
 * Calm by design (house style): a folder icon, the name, and a quiet child/article count. The
 * restricted/inherited padlock is presentation only — it mirrors the tree's affordance so a
 * restricted folder reads the same in both surfaces; the API enforces access (INV-9), never the UI.
 */
export function FolderBrowseCard({
  name,
  childCount,
  articleCount,
  restriction,
  ancestorName,
  onEnter,
}: {
  name: string;
  /** Number of direct sub-folders (omitted from the count line when 0). */
  childCount: number;
  /** Number of home articles in this folder (omitted when 0). */
  articleCount: number;
  /** How this folder's access reads: PUBLIC (no badge), its OWN rule, or INHERITED from an ancestor. */
  restriction: "public" | "own" | "inherited";
  /** The inheriting ancestor's name, for the inherited tooltip. */
  ancestorName?: string;
  /** Enter the folder (select it + drive the categoryId filter). */
  onEnter: () => void;
}) {
  const t = useTranslations("kb");

  const counts: string[] = [];
  if (childCount > 0)
    counts.push(t("folders.childFolderCount", { count: childCount }));
  if (articleCount > 0)
    counts.push(t("folders.articleCount", { count: articleCount }));

  return (
    <button
      type="button"
      onClick={onEnter}
      className="flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left text-card-foreground outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FolderIcon
        className="size-5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate font-medium">
          <span className="truncate">{name}</span>
          {restriction === "own" ? (
            <LockClosedIcon
              className="size-3.5 shrink-0 text-warning"
              aria-label={t("access.restrictedAriaLabel")}
            />
          ) : restriction === "inherited" ? (
            <LockClosedIcon
              className="size-3.5 shrink-0 text-warning/70"
              aria-label={t("access.inheritedRestrictedAriaLabel", {
                name: ancestorName ?? "",
              })}
            />
          ) : null}
        </p>
        {counts.length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">
            {counts.join(" · ")}
          </p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">
            {t("folders.emptyFolder")}
          </p>
        )}
      </div>
    </button>
  );
}
