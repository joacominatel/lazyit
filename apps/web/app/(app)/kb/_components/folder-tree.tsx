"use client";

import {
  ArrowsRightLeftIcon,
  ChevronRightIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  InboxIcon,
  LockClosedIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { isPublicAccessRules, type Folder } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ancestorFolderIds,
  buildFolderTree,
  descendantFolderCount,
  folderPathOptions,
  restrictedAncestorOf,
  type FolderNode,
  type FolderPathOption,
} from "@/lib/utils/folder-tree";
import { cn } from "@/lib/utils";
import {
  FolderAccessRuleEditor,
  type RawAccessRules,
} from "./folder-access-rule-editor";
import { FolderDeleteDialog } from "./folder-delete-dialog";
import { FolderFormDialog } from "./folder-form-dialog";
import { FolderMoveDialog } from "./folder-move-dialog";

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
  /** May be absent on older rows before the column migration ran; null/empty = PUBLIC. */
  accessRules?: RawAccessRules;
};

/**
 * FolderTree — the collapsible, keyboard-navigable hierarchical browser for the Knowledge Base
 * (ADR-0059 §1). The flat `Folder` list (an `ArticleCategory` + `parentId`) is projected into a tree
 * (`buildFolderTree`); selecting a folder drives the KB list's existing `categoryId` filter, so the
 * grid shows that folder's home articles. The sidebar keeps its single "Knowledge" entry — the tree
 * lives INSIDE the KB view.
 *
 * ADR-0060 / #406 — restricted-folder affordances:
 *   - A padlock icon + "Restricted" tooltip appears on folders carrying a non-empty access rule.
 *   - An inheritance indicator is shown on child folders whose nearest restricted ancestor is
 *     restricting them (the effective rule is always the backend's — never recomputed here).
 *   - ADMIN-only: a settings Popover on each folder row exposes the {@link FolderAccessRuleEditor}.
 *     The padlock is presentation; the API enforces (INV-9).
 *
 * #1291 — write affordances. With `category:write` the rail gains a "New folder" button (a ROOT
 * folder) and every row's "⋯" menu gains "New sub-folder here" (create with this row's id as
 * `parentId`), "Rename" and "Move to…". That is what makes sub-folders producible from the UI at
 * all: the shared name-only quick-create always lands a folder at the root. The guards (cycle,
 * dead parent, per-parent unique name) stay entirely server-side; the dialogs report what the API
 * answers. After a create or a move the affected branch is expanded so the result is visible
 * without a reload.
 *
 * a11y: an `role="tree"` with `role="treeitem"` rows; each branch carries `aria-expanded`; the active
 * folder carries `aria-selected`. Rows are real `<button>`s, so Enter/Space select and Tab moves
 * between them for free; the chevron toggles expansion without changing selection.
 */
export function FolderTree({
  folders,
  selectedFolderId,
  onSelect,
  isAdmin,
  canWrite,
  canDelete,
}: {
  folders: FolderWithRules[];
  /** The folder whose articles the list is currently filtered to (`null` = "All articles"). */
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  /** When true the per-folder access-rule editor affordance is rendered (ADMIN-only, ADR-0060). */
  isAdmin?: boolean;
  /** When true the create / rename / move affordances are rendered (`category:write`, #1291). */
  canWrite?: boolean;
  /** When true the per-folder "⋯ → Delete folder" cascade affordance is rendered (`category:delete`, #415). */
  canDelete?: boolean;
}) {
  const t = useTranslations("kb");
  // Cast to Folder[] for the tree-building utilities which only need the structural fields.
  const tree = useMemo(
    () => buildFolderTree(folders as Folder[]),
    [folders],
  );

  // Build a set of restricted ancestor ids so child folders can show an inheritance indicator.
  // This is a PRESENTATION hint — the backend never lets a child widen past an ancestor's rule.
  const restrictedFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of folders) {
      if (!isPublicAccessRules((f as FolderWithRules).accessRules as Parameters<typeof isPublicAccessRules>[0])) {
        ids.add(f.id);
      }
    }
    return ids;
  }, [folders]);

  // Build a parent→id lookup so we can check ancestry quickly.
  const parentById = useMemo(
    () => new Map(folders.map((f) => [f.id, f.parentId ?? null])),
    [folders],
  );

  /**
   * Returns the id of the nearest restricted ancestor of `folderId`, or null when no restricted
   * ancestor exists. Used only for the "inherits restriction from ancestor" indicator — the rule is
   * the server's, never recomputed here. Delegates to the shared pure helper (#414).
   */
  function restrictedAncestorId(folderId: string): string | null {
    return restrictedAncestorOf(folderId, parentById, restrictedFolderIds);
  }

  // Resolve an ancestor folder's display name for the inherited-restriction tooltip (#414).
  const nameById = useMemo(
    () => new Map(folders.map((f) => [f.id, f.name])),
    [folders],
  );

  // Descendant-folder counts for the cascade-delete warning pre-count (#415).
  const descendantCountById = useMemo(() => {
    if (!canDelete) return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const f of folders) {
      counts.set(f.id, descendantFolderCount(folders as Folder[], f.id));
    }
    return counts;
  }, [folders, canDelete]);

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

  // Destinations for "Move to…", path-labelled and sorted once for the whole tree (#1291). Each row
  // drops its own id before handing the list to the dialog; descendants stay in — the cycle rule is
  // the API's (ADR-0059 §1) and is reported, never recomputed here.
  const moveOptions = useMemo(
    () => (canWrite ? folderPathOptions(folders as Folder[]) : []),
    [folders, canWrite],
  );

  // The root-level "New folder" dialog, owned by the rail rather than by a row.
  const [newRootOpen, setNewRootOpen] = useState(false);

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
      {/* #1291: a ROOT folder has no row to hang a "⋯" menu on, so the rail carries its own quiet
          "New folder" action. A real <button> above the tree — outside role="tree", so it never
          appears as a treeitem to a screen reader. */}
      {canWrite ? (
        <button
          type="button"
          onClick={() => setNewRootOpen(true)}
          className="mb-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PlusIcon className="size-3.5 shrink-0" aria-hidden />
          {t("folders.form.newRoot")}
        </button>
      ) : null}

      {newRootOpen ? (
        <FolderFormDialog
          open={newRootOpen}
          onOpenChange={setNewRootOpen}
          mode="create"
          parentId={null}
          onCreated={(id) => onSelect(id)}
        />
      ) : null}

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
              node={node as FolderNodeWithRules}
              depth={0}
              selectedFolderId={selectedFolderId}
              isExpanded={isExpanded}
              onToggle={toggle}
              onSelect={onSelect}
              onExpand={expand}
              isAdmin={isAdmin}
              canWrite={canWrite}
              canDelete={canDelete}
              moveOptions={moveOptions}
              restrictedFolderIds={restrictedFolderIds}
              restrictedAncestorId={restrictedAncestorId}
              nameById={nameById}
              descendantCountById={descendantCountById}
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

type FolderNodeWithRules = FolderNode & {
  folder: FolderWithRules;
  children: FolderNodeWithRules[];
};

/** One folder row (and, when expanded, its children). Indentation is depth-driven padding. */
function FolderTreeNode({
  node,
  depth,
  selectedFolderId,
  isExpanded,
  onToggle,
  onSelect,
  onExpand,
  isAdmin,
  canWrite,
  canDelete,
  moveOptions,
  restrictedFolderIds,
  restrictedAncestorId,
  nameById,
  descendantCountById,
}: {
  node: FolderNodeWithRules;
  depth: number;
  selectedFolderId: string | null;
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
  onSelect: (folderId: string | null) => void;
  /** Force a branch open (create/move reveal) — distinct from `onToggle`, which flips it. */
  onExpand: (id: string) => void;
  isAdmin?: boolean;
  canWrite?: boolean;
  canDelete?: boolean;
  /** Every folder as a path-labelled destination; this row removes itself before offering them. */
  moveOptions: FolderPathOption[];
  restrictedFolderIds: Set<string>;
  restrictedAncestorId: (id: string) => string | null;
  nameById: Map<string, string>;
  descendantCountById: Map<string, number>;
}) {
  const t = useTranslations("kb");
  const { folder, children } = node;
  const hasChildren = children.length > 0;
  const expanded = isExpanded(folder.id);
  const selected = selectedFolderId === folder.id;
  // Indent each level; depth 0 leaves room so the chevron column aligns with the leading folder icon.
  const indentStyle = { paddingLeft: `${0.25 + depth * 0.875}rem` };
  const Icon = expanded && hasChildren ? FolderOpenIcon : FolderIcon;

  // ADR-0060: restriction state of THIS folder.
  const isRestricted = restrictedFolderIds.has(folder.id);
  // Whether a parent folder is restricting this one (presentation-only, server enforces).
  const ancestorId = isRestricted ? null : restrictedAncestorId(folder.id);
  const inheritsRestriction = Boolean(ancestorId);
  // The inheriting ancestor's display name, for the unambiguous inherited tooltip (#414).
  const ancestorName = ancestorId ? nameById.get(ancestorId) : undefined;

  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // #1291 write affordances. Each dialog is mounted only while open so a large tree never carries a
  // form instance per row.
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);

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

          {/* #1106 Phase 4: live-article count (ADR-0077 tabular-nums). Shown only when the API sent a
              number — it is null for a folder the viewer can't read and absent from a legacy server, so
              the row self-heals to no count. `ml-auto` right-aligns it; the padlock follows without its
              own `ml-auto` when a count is present. */}
          {folder.articleCount != null ? (
            <span
              className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
              aria-label={t("folders.articleCount", { count: folder.articleCount })}
              title={t("folders.articleCount", { count: folder.articleCount })}
            >
              {folder.articleCount}
            </span>
          ) : null}

          {/* ADR-0060: padlock affordance — restricted own rule */}
          {isRestricted ? (
            <span
              title={t("access.restrictedTooltip")}
              aria-label={t("access.restrictedAriaLabel")}
              className={cn(
                "shrink-0",
                folder.articleCount != null ? "ml-1.5" : "ml-auto",
              )}
            >
              <LockClosedIcon
                className="size-3.5 text-warning"
                aria-hidden
              />
            </span>
          ) : null}

          {/* #414: inherited-restriction padlock — a folder that INHERITS a restriction is restricted
              too (the backend enforces it), so it must read unambiguously as a LOCK, not a faint hint.
              A CLOSED padlock in a muted warning tone (distinct-but-related to the own-rule yellow),
              with a tooltip naming the inheriting ancestor. Presentation only — never asserts access. */}
          {inheritsRestriction ? (
            <span
              title={t("access.inheritedRestrictedTooltip", {
                name: ancestorName ?? "",
              })}
              aria-label={t("access.inheritedRestrictedAriaLabel", {
                name: ancestorName ?? "",
              })}
              className={cn(
                "shrink-0",
                folder.articleCount != null ? "ml-1.5" : "ml-auto",
              )}
            >
              <LockClosedIcon className="size-3.5 text-warning/70" aria-hidden />
            </span>
          ) : null}
        </button>

        {/* ADR-0060: ADMIN-only rule editor — a calm Popover triggered by a secondary icon-button.
            The padlock / inherited state are presentation only; the server enforces (INV-9). */}
        {isAdmin ? (
          <Popover open={editorOpen} onOpenChange={setEditorOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("access.editRulesAriaLabel", {
                  name: folder.name,
                })}
                title={t("access.editRulesTitle")}
                className={cn(
                  "ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 outline-none transition-colors",
                  "hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  (isRestricted || inheritsRestriction) &&
                    "text-muted-foreground/70",
                  editorOpen && "text-muted-foreground",
                )}
              >
                <LockClosedIcon className="size-3" aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-80 p-4"
              // Stop the click from bubbling to the folder-select button.
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 space-y-0.5">
                <p className="text-sm font-semibold">{t("access.editorTitle")}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {folder.name}
                </p>
              </div>
              <FolderAccessRuleEditor
                folderId={folder.id}
                folderName={folder.name}
                rawAccessRules={folder.accessRules ?? null}
                // #414: when this folder has no own rule but a restricted ancestor, the editor shows
                // the EFFECTIVE state as "Restricted (inherited from <ancestor>)" — never "Public".
                inheritedFrom={inheritsRestriction ? (ancestorName ?? null) : null}
              />
            </PopoverContent>
          </Popover>
        ) : null}

        {/* The per-row overflow menu. A "⋯" trigger keeps the row calm until invoked. Items are gated
            individually: create / rename / move on `category:write` (#1291), the cascade delete on
            `category:delete` (#415). Radix renders the menu as a real `menu`/`menuitem` widget, so
            every item is reachable with the keyboard (Enter/Space on the trigger, arrows, Escape)
            and the tree's own treeitem semantics are untouched. */}
        {canWrite || canDelete ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("folders.actions.menuAriaLabel", {
                  name: folder.name,
                })}
                title={t("folders.actions.menuTitle")}
                className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 outline-none transition-colors hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(e) => e.stopPropagation()}
              >
                <EllipsisHorizontalIcon className="size-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              {canWrite ? (
                <>
                  <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
                    <FolderPlusIcon className="size-4" aria-hidden />
                    {t("folders.actions.newChild")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                    <PencilIcon className="size-4" aria-hidden />
                    {t("folders.actions.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
                    <ArrowsRightLeftIcon className="size-4" aria-hidden />
                    {t("folders.actions.move")}
                  </DropdownMenuItem>
                </>
              ) : null}
              {canWrite && canDelete ? <DropdownMenuSeparator /> : null}
              {canDelete ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleteOpen(true)}
                >
                  <TrashIcon className="size-4" aria-hidden />
                  {t("folders.delete.action")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {/* #1291: create a sub-folder under THIS row. On success the branch is expanded and the new
          folder selected, so it appears nested (and drives the list/breadcrumb) with no reload. */}
      {createOpen ? (
        <FolderFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          mode="create"
          parentId={folder.id}
          parentName={folder.name}
          onCreated={(createdId) => {
            onExpand(folder.id);
            onSelect(createdId);
          }}
        />
      ) : null}

      {renameOpen ? (
        <FolderFormDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          mode="rename"
          folderId={folder.id}
          folderName={folder.name}
        />
      ) : null}

      {moveOpen ? (
        <FolderMoveDialog
          open={moveOpen}
          onOpenChange={setMoveOpen}
          folderId={folder.id}
          folderName={folder.name}
          currentParentId={folder.parentId}
          options={moveOptions.filter((option) => option.id !== folder.id)}
          onMoved={(newParentId) => {
            if (newParentId) onExpand(newParentId);
          }}
        />
      ) : null}

      {canDelete ? (
        <FolderDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          folderId={folder.id}
          folderName={folder.name}
          descendantFolderCount={descendantCountById.get(folder.id) ?? 0}
          // When the deleted folder (or one of its descendants) was the active filter, drop back to
          // "All articles" so the grid isn't pinned to a now-archived folder.
          onDeleted={() => {
            if (
              selectedFolderId != null &&
              subtreeContains(node, selectedFolderId)
            ) {
              onSelect(null);
            }
          }}
        />
      ) : null}

      {hasChildren && expanded ? (
        <ul role="group" className="space-y-0.5">
          {children.map((child) => (
            <FolderTreeNode
              key={child.folder.id}
              node={child as FolderNodeWithRules}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              isExpanded={isExpanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onExpand={onExpand}
              isAdmin={isAdmin}
              canWrite={canWrite}
              canDelete={canDelete}
              moveOptions={moveOptions}
              restrictedFolderIds={restrictedFolderIds}
              restrictedAncestorId={restrictedAncestorId}
              nameById={nameById}
              descendantCountById={descendantCountById}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** True when `targetId` is this node's own folder or any folder in its subtree (cascade-aware). */
function subtreeContains(node: FolderNodeWithRules, targetId: string): boolean {
  if (node.folder.id === targetId) return true;
  return node.children.some((child) => subtreeContains(child, targetId));
}
