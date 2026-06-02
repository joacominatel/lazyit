"use client";

import { ArchiveBoxIcon } from "@heroicons/react/24/outline";
import { Switch } from "@/components/ui/switch";

/**
 * The ADMIN-only "Show archived" toggle for a resource list. When on, the page swaps its list query
 * to the `deleted=only` view (soft-deleted rows) — wire `checked`/`onCheckedChange` to a
 * `useListParams` filter (e.g. `filters.archived === "only"`) so the choice lands in the URL and is
 * shareable. Render it ONLY for admins (`usePermissions().isAdmin`); a non-admin can't reach the
 * archived view (and the API would 403 the restore anyway), so the toggle is hidden, not disabled.
 */
export function ArchivedToggle({
  checked,
  onCheckedChange,
  id = "show-archived",
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Element id linking the label to the switch (unique per page if multiple). */
  id?: string;
}) {
  return (
    <label
      htmlFor={id}
      className="inline-flex cursor-pointer items-center gap-2 rounded-md text-sm font-medium text-muted-foreground select-none"
    >
      <ArchiveBoxIcon className="size-4" />
      Show archived
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
