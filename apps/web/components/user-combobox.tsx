"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Combobox } from "@/components/combobox";
import { useUser, useUserList } from "@/lib/api/hooks/use-users";

/**
 * A server-search user picker (issue #199): the {@link Combobox} wired to the `q`-driven paged
 * `useUserList` hook, so the assign/grant dialogs no longer materialize the whole directory just to
 * fill a dropdown. Only ACTIVE users are offered (and any `excludeUserIds` are hidden — e.g. an
 * asset's current owners). The selected user's name is resolved via `useUser` so the trigger keeps
 * showing it even after the search pages away from that row.
 *
 * Controlled by `value`/`onValueChange` (the user id), and it forwards `id` + `ariaInvalid` so it
 * drops into the `Field`/`FieldError` + react-hook-form `Controller` contract exactly like the
 * `Select` it replaces.
 */
export function UserCombobox({
  id,
  value,
  onValueChange,
  ariaInvalid,
  disabled,
  excludeUserIds = [],
  placeholder,
  searchPlaceholder,
  emptyText,
}: {
  id?: string;
  value?: string;
  onValueChange: (value: string) => void;
  ariaInvalid?: boolean;
  disabled?: boolean;
  /** User ids to hide from the list (e.g. an asset's current owners). */
  excludeUserIds?: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  // Active-only directory page for the current query. The status filter is client-side over the page
  // (the user list's `q` is server-side; `isActive` is not a server param — see endpoints/users.ts).
  const { data, isFetching } = useUserList({ q: query || undefined, limit: 50 });
  // Resolve the selected user's label even when it isn't on the current search page.
  const { data: selected } = useUser(value || undefined);

  const items = useMemo(() => {
    const excluded = new Set(excludeUserIds);
    return (data?.items ?? [])
      .filter((user) => user.isActive && !excluded.has(user.id))
      .map((user) => ({
        value: user.id,
        label: `${user.firstName} ${user.lastName}`,
        keywords: [user.email],
      }));
  }, [data, excludeUserIds]);

  // Quick View (ADR-0072): the eye reads the ALREADY-LOADED list row — zero extra fetch. The
  // UserListItem carries email/role/status/legajo/username/manager + the optional asset/app counts.
  const byId = useMemo(
    () => new Map((data?.items ?? []).map((user) => [user.id, user])),
    [data],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onValueChange={onValueChange}
      items={items}
      onSearchChange={setQuery}
      loading={isFetching}
      selectedLabel={
        selected ? `${selected.firstName} ${selected.lastName}` : undefined
      }
      aria-invalid={ariaInvalid}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      loadingText={tc("searching")}
      typeToSearchText={tc("typeToSearch")}
      quickView={(rowId) => {
        const user = byId.get(rowId);
        return user ? { entity: "user", data: user } : null;
      }}
    />
  );
}
