"use client";

import { ArchiveBoxIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";

/**
 * The ADMIN-only "Show archived" toggle for a resource list. When on, the page swaps its list query
 * to the `deleted=only` view (soft-deleted rows) — wire `checked`/`onCheckedChange` to a
 * `useListParams` filter (e.g. `filters.archived === "only"`) so the choice lands in the URL and is
 * shareable. Render it ONLY for admins (`usePermissions().isAdmin`) — note this stays role-based even
 * after the RBAC v2 gating migration (ADR-0046): the API's `assertCanListDeleted` keeps the
 * `deleted=only` slice ADMIN-only (it was deliberately NOT migrated to a permission), so this toggle
 * must match `isAdmin`, not a `can(':delete')` gate. A non-admin can't reach the archived view, so the
 * toggle is hidden, not disabled.
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
  const t = useTranslations("shared");
  return (
    <label
      htmlFor={id}
      className="inline-flex cursor-pointer items-center gap-2 rounded-md text-sm font-medium text-muted-foreground select-none"
    >
      <ArchiveBoxIcon className="size-4" />
      {t("filters.showArchived")}
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
