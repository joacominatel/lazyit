"use client";

import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  InboxIcon,
} from "@heroicons/react/24/outline";
import type { Folder } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  ancestorFolderIds,
  buildFolderTree,
  type FolderNode,
} from "@/lib/utils/folder-tree";
import { cn } from "@/lib/utils";

/**
 * FolderTree — the collapsible, keyboard-navigable hierarchical browser for the Knowledge Base
 * (ADR-0059 §1). The flat `Folder` list (an `ArticleCategory` + `parentId`) is projected into a tree
 * (`buildFolderTree`); selecting a folder drives the KB list's existing `categoryId` filter, so the
 * grid shows that folder's home articles. The sidebar keeps its single "Knowledge" entry — the tree
 * lives INSIDE the KB view.
 *
 * No access semantics here (ADR-0059 ships structure only): every folder the API returns is rendered,
 * with NO padlock / restricted-folder UI — that is ADR-0060 / #365.
 *
 * a11y: an `role="tree"` with `role="treeitem"` rows; each branch carries `aria-expanded`; the active
 * folder carries `aria-selected`. Rows are real `<button>`s, so Enter/Space select and Tab moves
 * between them for free; the chevron toggles expansion without changing selection.
 */
export function FolderTree({
  folders,
  selectedFolderId,
  onSelect,
}: {
  folders: Folder[];
  /** The folder whose articles the list is currently filtered to (`null` = "All articles"). */
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
}) {
  const t = useTranslations("kb");
  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  // Auto-expand the path down to the selected folder so a deep selection is always visible. Beyond
  // that the user's explicit toggles win (tracked in `expanded`); the derived ancestor set seeds it.
  const ancestors = useMemo(
    () => ancestorFolderIds(folders, selectedFolderId),
    [folders, selectedFolderId],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const isExpanded = (id: string) => expanded.has(id) || ancestors.has(id);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      // Reconcile with the derived ancestor state so the first toggle of an auto-opened branch
      // collapses it (rather than no-opping because the Set didn't yet contain it).
      const open = next.has(id) || ancestors.has(id);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <nav aria-label={t("folders.treeLabel")} className="text-sm">
      <ul role="tree" className="space-y-0.5">
        {/* "All articles" — clears the folder filter. The implicit root of the browse. The leading
            spacer matches the folder rows' chevron column so the labels align. */}
        <li role="none">
          <div className="flex items-center">
            <span className="size-6 shrink-0" aria-hidden />
            <button
              type="button"
              role="treeitem"
              aria-selected={selectedFolderId === null}
              onClick={() => onSelect(null)}
              className={cn(
                rowClass,
                selectedFolderId === null && rowActiveClass,
              )}
            >
              <InboxIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{t("folders.allArticles")}</span>
            </button>
          </div>
        </li>

        {tree.length === 0 ? (
          <li role="none" className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("folders.empty")}
          </li>
        ) : (
          tree.map((node) => (
            <FolderTreeNode
              key={node.folder.id}
              node={node}
              depth={0}
              selectedFolderId={selectedFolderId}
              isExpanded={isExpanded}
              onToggle={toggle}
              onSelect={onSelect}
            />
          ))
        )}
      </ul>
    </nav>
  );
}

const rowClass =
  "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
const rowActiveClass =
  "bg-accent/60 font-medium text-foreground hover:bg-accent/60";

/** One folder row (and, when expanded, its children). Indentation is depth-driven padding. */
function FolderTreeNode({
  node,
  depth,
  selectedFolderId,
  isExpanded,
  onToggle,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  selectedFolderId: string | null;
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
  onSelect: (folderId: string | null) => void;
}) {
  const t = useTranslations("kb");
  const { folder, children } = node;
  const hasChildren = children.length > 0;
  const expanded = isExpanded(folder.id);
  const selected = selectedFolderId === folder.id;
  // Indent each level; depth 0 leaves room so the chevron column aligns with the leading folder icon.
  const indentStyle = { paddingLeft: `${0.25 + depth * 0.875}rem` };
  const Icon = expanded && hasChildren ? FolderOpenIcon : FolderIcon;

  return (
    <li role="none">
      <div className="flex items-center" style={indentStyle}>
        {/* A real chevron <button> toggles expansion WITHOUT selecting (Enter/Space for free); a leaf
            gets a same-width spacer so labels stay aligned. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(folder.id)}
            aria-label={t(
              expanded ? "folders.collapse" : "folders.expand",
              { name: folder.name },
            )}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="size-6 shrink-0" aria-hidden />
        )}
        {/* The treeitem itself is a focusable <button> that SELECTS the folder (drives the filter). */}
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined}
          onClick={() => onSelect(folder.id)}
          className={cn(rowClass, selected && rowActiveClass)}
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{folder.name}</span>
        </button>
      </div>

      {hasChildren && expanded ? (
        <ul role="group" className="space-y-0.5">
          {children.map((child) => (
            <FolderTreeNode
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              isExpanded={isExpanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
