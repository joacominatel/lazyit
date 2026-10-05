"use client";

import {
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
  EllipsisVerticalIcon,
  PencilSquareIcon,
  TagIcon,
  TrashIcon,
  UserMinusIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { StatusChoice, StatusLabelOption } from "./asset-status-options";
import {
  AssetStatusMenuOptions,
  useAssetStatusOptions,
} from "./asset-status-picker";

/**
 * Assets-local row kebab — the expanded menu for an active (non-archived) asset row, kept out of the
 * shared `RowActions` (resource-table.tsx) so the generic one stays lean (#695, row-actions sub-wave).
 *
 * Items, in order: Open in new tab · Edit · Clone · — · Assign/Remove assignment (the inverse of the
 * row's colored quick button) · Change status (a submenu of the grouped status options — every built-in
 * status and its custom statuses, ADR-0101 — the current one checked) · — · Delete. Every group is INDEPENDENTLY GATED on the caller's
 * permissions, mirroring the shared `RowActions` contract:
 *  - `onEdit`/`onClone` and `onAssign`/`onUnassign`/`onChangeStatus` → `can('asset:write')`
 *  - `onDelete` → `can('asset:delete')`
 * Pass only the handlers the operator is allowed to run; an omitted handler hides its item. The page
 * must not render this at all when no item would (an empty menu = a dead trigger).
 *
 * Dialogs (Assign / Unassign confirm / Delete confirm) are opened via page state as SIBLINGS of the
 * menu, never nested here — the documented Radix way to avoid focus / pointer-event locks. So the
 * handlers below only flip page state; they don't render dialogs.
 */
export function AssetRowActions({
  assetId,
  currentStatus,
  currentLabel,
  hasOwner,
  onEdit,
  onClone,
  onAssign,
  onUnassign,
  onChangeStatus,
  onDelete,
}: {
  assetId: string;
  /** Current status (built-in + custom) — the checked option in the "Change status" submenu. */
  currentStatus: StatusChoice;
  /** The asset's inline custom status, so it has an option even when the list cannot be read. */
  currentLabel?: StatusLabelOption | null;
  /** True when the asset has at least one active owner — toggles Assign vs Remove assignment. */
  hasOwner: boolean;
  /** Edit (gate on `asset:write`). */
  onEdit?: () => void;
  /** Clone — opens the create flow pre-filled (a clone is a create; gate on `asset:write`). */
  onClone?: () => void;
  /** Open the Assign dialog (gate on `asset:write`). Shown only when `!hasOwner`. */
  onAssign?: () => void;
  /** Open the Unassign confirm (gate on `asset:write`). Shown only when `hasOwner`. */
  onUnassign?: () => void;
  /** Set a new status (gate on `asset:write`). Reversible, so no confirm — matches the batch flow. */
  onChangeStatus?: (choice: StatusChoice) => void;
  /** Open the Delete confirm (gate on `asset:delete`). */
  onDelete?: () => void;
}) {
  const t = useTranslations("assets.rowActions");
  const tShared = useTranslations("shared");
  const statusGroups = useAssetStatusOptions(currentLabel);

  const canWrite =
    onEdit != null ||
    onClone != null ||
    onAssign != null ||
    onUnassign != null ||
    onChangeStatus != null;
  // The assignment item: Assign when there's no owner, Remove assignment when there is.
  const assignItem = hasOwner ? onUnassign : onAssign;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tShared("table.openActions")}
        >
          <EllipsisVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          {/* A real link so middle/modifier-click and the row's own open-in-new-tab affordance behave. */}
          <Link href={`/assets/${assetId}`} target="_blank" rel="noopener">
            <ArrowTopRightOnSquareIcon />
            {t("openInNewTab")}
          </Link>
        </DropdownMenuItem>

        {onEdit ? (
          <DropdownMenuItem onSelect={onEdit}>
            <PencilSquareIcon />
            {tShared("table.edit")}
          </DropdownMenuItem>
        ) : null}
        {onClone ? (
          <DropdownMenuItem onSelect={onClone}>
            <DocumentDuplicateIcon />
            {tShared("table.clone")}
          </DropdownMenuItem>
        ) : null}

        {canWrite ? <DropdownMenuSeparator /> : null}

        {assignItem ? (
          <DropdownMenuItem onSelect={assignItem}>
            {hasOwner ? <UserMinusIcon /> : <UserPlusIcon />}
            {hasOwner ? t("removeAssignment") : t("assign")}
          </DropdownMenuItem>
        ) : null}

        {onChangeStatus ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <TagIcon />
              {t("changeStatus")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
              <AssetStatusMenuOptions
                groups={statusGroups}
                value={currentStatus}
                onSelect={onChangeStatus}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}

        {onDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <TrashIcon />
              {tShared("table.delete")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
