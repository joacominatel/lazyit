"use client";

import { ChevronRightIcon } from "@heroicons/react/24/outline";
import type { Folder } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  ancestorFolderIds,
  buildFolderTree,
  restrictedAncestorOf,
  type FolderNode,
} from "@/lib/utils/folder-tree";
import { restrictedFolderIdSet } from "@/lib/utils/kb-folder-access";
import { cn } from "@/lib/utils";
import type { RawAccessRules } from "./folder-access-rule-editor";
import { FolderActionsMenu, type FolderPermissions } from "./folder-actions-menu";
import { FolderTile } from "./folder-tile";
import { RestrictionPadlock } from "./restriction-padlock";

/**
 * The folder `accessRules` field is a `Json?` on the Prisma model, returned in the API response
 * but not included in the shared `ArticleCategorySchema` (which drives the `Folder` type). The web
 * layer casts the raw API response to this extended type so the tree and rule editor can read the
 * presence of a restriction without having to add the field to the shared schema.
 *
 * The field's TYPE (the actual rule vocabulary) is validated by `@lazyit/shared`'s
 * `FolderAccessRuleSchema` / `FolderAccessRulesSchema` wherever we interpret the value
 * (e.g. `isPublicAccessRules`). It's safe to cast here because the API validated and stored the
 * JSON via `UpdateFolderAccessRulesSchema` before the row was ever returned.
 */
export type FolderWithRules = Folder & {
  /** Sent only to a `settings:manage` caller (#554); null/empty = PUBLIC. */
  accessRules?: RawAccessRules;
};

/**
 * FolderTree — the collapsible, keyboard-navigable folder browser in the KB rail (ADR-0059 §1,
 * #1539). The flat `Folder` list is projected into a tree (`buildFolderTree`); picking a folder opens
 * its browse view (the shell navigates to `?categoryId=`). The views above it ("All articles", "My
 * drafts", …) and the "+" for a new root folder live in the shell's rail, not here.
 *
 * Each row: a chevron (branches), the folder's colour tile, its name, its article count right-aligned
 * in tabular figures, ONE padlock only when the folder is restricted — its own rule in the warning
 * tone, an inherited one in a muted warning tone with a tooltip naming the ancestor (#414) — and the
 * "⋯" menu ({@link FolderActionsMenu}). The menu trigger stays out of the way: it shows on row hover,
 * on keyboard focus inside the row, on the selected row, and always on touch screens (no hover). The
 * padlock is presentation only; the API enforces (INV-9). Restriction reads the #1299 `hasAccessRules`
 * flag, so every viewer sees the padlock, not only administrators.
 *
 * a11y: `role="tree"` with `role="treeitem"` rows; each branch carries `aria-expanded`; the active
 * folder carries `aria-selected`. Rows are real `<button>`s, so Enter/Space select and Tab moves
 * between them; the chevron toggles expansion without changing selection.
 */
export function FolderTree({
  folders,
  selectedFolderId,
  onSelect,
  perms,
}: {
  folders: FolderWithRules[];
  /** The folder the browse view shows (`null` = none). */
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  perms: FolderPermissions;
}) {
  const t = useTranslations("kb");
  const tree = useMemo(() => buildFolderTree(folders as Folder[]), [folders]);

  // Folders that carry their own restriction (presentation; the server never lets a child widen).
  const restrictedFolderIds = useMemo(() => restrictedFolderIdSet(folders), [folders]);
  const parentById = useMemo(
    () => new Map(folders.map((f) => [f.id, f.parentId ?? null])),
    [folders],
  );
  const nameById = useMemo(
    () => new Map(folders.map((f) => [f.id, f.name])),
    [folders],
  );

  // Auto-expand the path down to the selected folder so a deep selection is always visible. Beyond
  // that the user's explicit toggles win (tracked in `expanded`); the derived ancestor set seeds it.
  const ancestors = useMemo(
    () => ancestorFolderIds(folders as Folder[], selectedFolderId),
    [folders, selectedFolderId],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const isExpanded = (id: string) => expanded.has(id) || ancestors.has(id);

  /** Force a branch open — after a create or a move, so the affected folder is visible at once. */
  const expand = (id: string) => {
    setExpanded((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

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

  if (tree.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        {t("folders.empty")}
      </p>
    );
  }

  return (
    <ul role="tree" aria-label={t("folders.treeLabel")} className="space-y-px text-sm">
      {tree.map((node) => (
        <FolderTreeNode
          key={node.folder.id}
          node={node as FolderNodeWithRules}
          depth={0}
          ctx={{
            selectedFolderId,
            isExpanded,
            onToggle: toggle,
            onSelect,
            onExpand: expand,
            perms,
            folders,
            restrictedFolderIds,
            parentById,
            nameById,
          }}
        />
      ))}
    </ul>
  );
}

type FolderNodeWithRules = FolderNode & {
  folder: FolderWithRules;
  children: FolderNodeWithRules[];
};

/** Everything a row needs from the tree, passed down as one stable bag. */
interface TreeContext {
  selectedFolderId: string | null;
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
  onSelect: (folderId: string | null) => void;
  onExpand: (id: string) => void;
  perms: FolderPermissions;
  folders: FolderWithRules[];
  restrictedFolderIds: Set<string>;
  parentById: Map<string, string | null>;
  nameById: Map<string, string>;
}

/** One folder row (and, when expanded, its children). Indentation is depth-driven padding. */
function FolderTreeNode({
  node,
  depth,
  ctx,
}: {
  node: FolderNodeWithRules;
  depth: number;
  ctx: TreeContext;
}) {
  const t = useTranslations("kb");
  const { folder, children } = node;
  const hasChildren = children.length > 0;
  const expanded = ctx.isExpanded(folder.id);
  const selected = ctx.selectedFolderId === folder.id;
  const indentStyle = { paddingLeft: `${depth * 0.875}rem` };

  // ADR-0060: this folder's own rule, else the nearest restricted ancestor (#414). Presentation only.
  const isRestricted = ctx.restrictedFolderIds.has(folder.id);
  const ancestorId = isRestricted
    ? null
    : restrictedAncestorOf(folder.id, ctx.parentById, ctx.restrictedFolderIds);
  const ancestorName = ancestorId ? (ctx.nameById.get(ancestorId) ?? "") : "";

  return (
    <li role="none">
      <div
        className={cn(
          "group/row flex items-center rounded-md pr-1 transition-colors hover:bg-accent/50",
          selected && "bg-accent/70 hover:bg-accent/70",
        )}
        style={indentStyle}
      >
        {/* A real chevron <button> toggles expansion WITHOUT selecting; a leaf gets a same-width
            spacer so labels stay aligned. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => ctx.onToggle(folder.id)}
            aria-label={t(expanded ? "folders.collapse" : "folders.expand", {
              name: folder.name,
            })}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="size-6 shrink-0" aria-hidden />
        )}

        {/* The treeitem itself is a focusable <button> that opens the folder. */}
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined}
          onClick={() => ctx.onSelect(folder.id)}
          title={folder.name}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-1 text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            selected && "font-medium text-foreground",
          )}
        >
          <FolderTile folderId={folder.id} />
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>

          {isRestricted || ancestorId ? (
            <RestrictionPadlock
              inheritedFrom={isRestricted ? null : ancestorName}
            />
          ) : null}

          {/* Live-article count (#1106 Phase 4): null for a folder the viewer can't read and absent
              on a legacy server, so the row self-heals to no number. */}
          {folder.articleCount != null ? (
            <span
              className="min-w-5 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums"
              title={t("folders.articleCount", { count: folder.articleCount })}
            >
              {folder.articleCount}
            </span>
          ) : null}
        </button>

        <FolderActionsMenu
          folder={folder}
          folders={ctx.folders}
          perms={ctx.perms}
          showNewChild
          selectedFolderId={ctx.selectedFolderId}
          onSelect={ctx.onSelect}
          onExpand={ctx.onExpand}
          triggerClassName={cn(
            "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
            selected && "opacity-100",
          )}
        />
      </div>

      {hasChildren && expanded ? (
        <ul role="group" className="space-y-px">
          {children.map((child) => (
            <FolderTreeNode
              key={child.folder.id}
              node={child as FolderNodeWithRules}
              depth={depth + 1}
              ctx={ctx}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
