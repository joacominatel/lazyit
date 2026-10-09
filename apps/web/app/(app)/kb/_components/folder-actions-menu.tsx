"use client";

import {
  ArrowsRightLeftIcon,
  EllipsisHorizontalIcon,
  FolderPlusIcon,
  LockClosedIcon,
  PencilIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { Folder } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  ancestorFolderIds,
  descendantFolderCount,
  folderPathOptions,
  restrictedAncestorOf,
} from "@/lib/utils/folder-tree";
import { restrictedFolderIdSet } from "@/lib/utils/kb-folder-access";
import { FolderAccessRuleEditor } from "./folder-access-rule-editor";
import { FolderDeleteDialog } from "./folder-delete-dialog";
import { FolderFormDialog } from "./folder-form-dialog";
import { FolderMoveDialog } from "./folder-move-dialog";
import type { FolderWithRules } from "./folder-tree";

/** The capability gates the menu reads — each item is shown only when its gate holds. */
export interface FolderPermissions {
  /** `category:write` — new sub-folder, edit, move (#1291). */
  canWrite: boolean;
  /** `category:delete` — the cascade delete (#415). */
  canDelete: boolean;
  /** `settings:manage` — the access-rule editor (ADR-0060). */
  isAdmin: boolean;
}

/** True when at least one item of the menu would render — callers skip the trigger otherwise. */
export function hasFolderActions(perms: FolderPermissions): boolean {
  return perms.canWrite || perms.canDelete || perms.isAdmin;
}

/**
 * The "⋯" menu of one KB folder (#1539), shared by the rail rows and the folder header so both offer
 * the same actions behind the same gates: New sub-folder here (rail only), Edit, Move to…, Access…
 * and Delete. "Access…" moved here from the always-visible padlock button the rail used to carry; it
 * opens the existing {@link FolderAccessRuleEditor} in a dialog, ADMIN-only as before (the API is the
 * boundary, INV-9). Every dialog mounts only while open, so a long tree carries no form per row.
 *
 * Radix renders a real `menu`/`menuitem` widget, so every item is keyboard reachable and the rail's
 * treeitem semantics are untouched.
 */
export function FolderActionsMenu({
  folder,
  folders,
  perms,
  showNewChild = false,
  selectedFolderId,
  onSelect,
  onExpand,
  triggerClassName,
}: {
  folder: FolderWithRules;
  folders: FolderWithRules[];
  perms: FolderPermissions;
  /** Offer "New sub-folder here" (the rail; the folder header has its own visible button). */
  showNewChild?: boolean;
  /** The folder the browse page currently shows — a delete that removes it navigates away. */
  selectedFolderId: string | null;
  /** Navigate to a folder (`null` = All articles). */
  onSelect: (folderId: string | null) => void;
  /** Force a branch of the rail open after a create or a move. */
  onExpand?: (folderId: string) => void;
  triggerClassName?: string;
}) {
  const t = useTranslations("kb");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { canWrite, canDelete, isAdmin } = perms;
  if (!hasFolderActions(perms)) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("folders.actions.menuAriaLabel", { name: folder.name })}
            title={t("folders.actions.menuTitle")}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground",
              triggerClassName,
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <EllipsisHorizontalIcon className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="w-52">
          {canWrite && showNewChild ? (
            <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
              <FolderPlusIcon className="size-4" aria-hidden />
              {t("folders.actions.newChild")}
            </DropdownMenuItem>
          ) : null}
          {canWrite ? (
            <>
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                <PencilIcon className="size-4" aria-hidden />
                {t("folders.actions.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
                <ArrowsRightLeftIcon className="size-4" aria-hidden />
                {t("folders.actions.move")}
              </DropdownMenuItem>
            </>
          ) : null}
          {isAdmin ? (
            <DropdownMenuItem onSelect={() => setAccessOpen(true)}>
              <LockClosedIcon className="size-4" aria-hidden />
              {t("folders.actions.access")}
            </DropdownMenuItem>
          ) : null}
          {canDelete ? (
            <>
              {canWrite || isAdmin ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                <TrashIcon className="size-4" aria-hidden />
                {t("folders.delete.action")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {createOpen ? (
        <FolderFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          mode="create"
          parentId={folder.id}
          parentName={folder.name}
          onCreated={(createdId) => {
            onExpand?.(folder.id);
            onSelect(createdId);
          }}
        />
      ) : null}

      {editOpen ? (
        <FolderFormDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          mode="edit"
          folder={folder}
        />
      ) : null}

      {moveOpen ? (
        <FolderMoveDialogFor
          folder={folder}
          folders={folders}
          onOpenChange={setMoveOpen}
          onMoved={(newParentId) => {
            if (newParentId) onExpand?.(newParentId);
          }}
        />
      ) : null}

      {accessOpen ? (
        <FolderAccessDialog
          folder={folder}
          folders={folders}
          onOpenChange={setAccessOpen}
        />
      ) : null}

      {deleteOpen ? (
        <FolderDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          folderId={folder.id}
          folderName={folder.name}
          descendantFolderCount={descendantFolderCount(folders as Folder[], folder.id)}
          // When the deleted folder (or one of its descendants) is open, drop back to All articles so
          // the page is not pinned to an archived folder.
          onDeleted={() => {
            if (
              selectedFolderId != null &&
              (selectedFolderId === folder.id ||
                ancestorFolderIds(folders as Folder[], selectedFolderId).has(folder.id))
            ) {
              onSelect(null);
            }
          }}
        />
      ) : null}
    </>
  );
}

/** The move dialog with its path-labelled destinations (the folder itself excluded). */
function FolderMoveDialogFor({
  folder,
  folders,
  onOpenChange,
  onMoved,
}: {
  folder: FolderWithRules;
  folders: FolderWithRules[];
  onOpenChange: (open: boolean) => void;
  onMoved: (newParentId: string | null) => void;
}) {
  // Descendants stay in the list: the cycle rule is the API's (ADR-0059 §1) and is reported, never
  // recomputed here.
  const options = useMemo(
    () => folderPathOptions(folders as Folder[]).filter((option) => option.id !== folder.id),
    [folders, folder.id],
  );
  return (
    <FolderMoveDialog
      open
      onOpenChange={onOpenChange}
      folderId={folder.id}
      folderName={folder.name}
      currentParentId={folder.parentId}
      options={options}
      folders={folders}
      onMoved={onMoved}
    />
  );
}

/**
 * The ADMIN-only access-rule editor (ADR-0060 §3) in a dialog. When the folder has no rule of its own
 * but a restricted ancestor, the editor shows the effective state as "Restricted (inherited from …)"
 * rather than "Public" (#414).
 */
function FolderAccessDialog({
  folder,
  folders,
  onOpenChange,
}: {
  folder: FolderWithRules;
  folders: FolderWithRules[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("kb");
  const inheritedFrom = useMemo(() => {
    const restricted = restrictedFolderIdSet(folders);
    if (restricted.has(folder.id)) return null;
    const parentById = new Map(folders.map((f) => [f.id, f.parentId ?? null]));
    const ancestorId = restrictedAncestorOf(folder.id, parentById, restricted);
    return ancestorId ? (folders.find((f) => f.id === ancestorId)?.name ?? null) : null;
  }, [folders, folder.id]);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("access.editorTitle")}</DialogTitle>
          <DialogDescription className="truncate">{folder.name}</DialogDescription>
        </DialogHeader>
        <FolderAccessRuleEditor
          folderId={folder.id}
          folderName={folder.name}
          rawAccessRules={folder.accessRules ?? null}
          inheritedFrom={inheritedFrom}
        />
      </DialogContent>
    </Dialog>
  );
}
