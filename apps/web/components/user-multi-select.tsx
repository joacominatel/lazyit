"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  EntityMultiSelect,
  type EntityMultiSelectItem,
} from "@/components/entity-multi-select";
import { useUserList } from "@/lib/api/hooks/use-users";

/**
 * A **server-search** user multi-select (issue #937): {@link EntityMultiSelect} wired to the
 * `q`-driven paged `useUserList` hook (users already support server-side `q` — ADR-0030). The
 * multi-pick sibling of the single-select {@link UserCombobox} (#199) — same server-search infra,
 * but for picking SEVERAL people at once. No 200-user directory ceiling: any of the org's users is
 * reachable by name/email search, regardless of headcount (the old whole-directory `useUsers()`
 * lookup silently dropped everyone past the page cap).
 *
 * Only ACTIVE users are offered (the `isActive` filter is client-side over the page — it is not a
 * server `q` param; see endpoints/users.ts). `excludeUserIds` hides ids the caller already handles
 * (e.g. the subject being edited). Fully controlled by `selected` (the chosen user ids) + `onChange`;
 * the selected users' names are resolved by-id at the consumer, so an id off the current search page
 * still renders its label there.
 */
export function UserMultiSelect({
  label,
  selected,
  onChange,
  excludeUserIds = [],
  searchPlaceholder,
  emptyText,
  disabled,
  className,
}: {
  /** Trigger label, shown with the selection count (e.g. "Users (2)"). Already translated. */
  label: string;
  /** Currently-selected user ids (controlled). */
  selected: string[];
  /** Called with the next full selection whenever a user is toggled. */
  onChange: (next: string[]) => void;
  /** User ids to hide from the list. */
  excludeUserIds?: string[];
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}) {
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const { data, isFetching } = useUserList({ q: query || undefined, limit: 50 });

  const items = useMemo<EntityMultiSelectItem[]>(() => {
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
    <EntityMultiSelect
      label={label}
      items={items}
      selected={selected}
      onChange={onChange}
      onSearchChange={setQuery}
      loading={isFetching}
      searchPlaceholder={searchPlaceholder ?? tc("typeToSearch")}
      emptyText={emptyText}
      disabled={disabled}
      className={className}
      quickView={(rowId) => {
        const user = byId.get(rowId);
        return user ? { entity: "user", data: user } : null;
      }}
    />
  );
}
