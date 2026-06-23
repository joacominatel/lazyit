"use client";

import {
  ArrowUturnLeftIcon,
  PlusIcon,
  UserPlusIcon,
  UsersIcon,
  ViewColumnsIcon,
} from "@heroicons/react/24/outline";
import type { BatchResult, User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { ArchivedToggle } from "@/components/archived-toggle";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
  BatchActionBar,
  ErrorState,
  LinkableRow,
  Pagination,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
  RestoreRowAction,
  RowActions,
  rowActionsReveal,
  SelectCell,
  SortableHeader,
} from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell } from "@/components/ui/table";
import { UserAvatar } from "@/components/user-avatar";
import { useUserList } from "@/lib/api/hooks/use-users";
import { useRestoreUser } from "@/lib/api/hooks/use-user-mutations";
import { restoreUser } from "@/lib/api/endpoints/users";
import { notifyBatchResult } from "@/lib/api/notify-batch-result";
import { notifyError } from "@/lib/api/notify-error";
import { runPerIdBatch } from "@/lib/api/per-id-batch";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { cn } from "@/lib/utils";
import { ByoiBanner } from "./byoi-banner";
import { CloneUserWizard } from "./clone-user-wizard";
import { ManagerDisplay } from "./manager-display";
import { UserDirectoryBadge } from "./user-directory-badge";
import { OffboardingSheet } from "./offboarding-sheet";
import { UserFormDialog } from "./user-form-dialog";
import { UserRoleSelect } from "./user-role-select";
import { UserStatusBadge } from "./user-status-badge";

type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE";
/**
 * Directory filter (ADR-0069 REDESIGN §0 #2). Directory people (no login, created by the bulk import)
 * are mixed into the list and badged "Directory"; this slice lets an operator focus on one kind.
 * `ALL` → both (default, omitted from the query), `directory` → only directory people
 * (`directoryOnly=true`), `accounts` → only real login accounts (`directoryOnly=false`).
 */
type DirectoryFilter = "ALL" | "directory" | "accounts";

/**
 * Filter param defaults. `status` (active/inactive) is filtered client-side over the page.
 * `archived` ("ALL" | "only") drives the ADMIN-only `deleted=only` view via the URL. `directory`
 * ("ALL" | "directory" | "accounts") drives the server-side `directoryOnly` slice.
 */
const FILTER_DEFAULTS = {
  status: "ALL",
  archived: "ALL",
  directory: "ALL",
} as const;

/**
 * The Users-table columns an operator can show/hide via the column picker (#368, extended in #386).
 * Structural columns (`avatar`, the selection checkbox, row `actions`) and the `name` identity column —
 * the row's canonical link — are always rendered and intentionally absent here. Keys match the
 * `ResourceColumn` keys and the per-key body-cell map below, so the header and body never drift, and
 * the ARRAY ORDER is the canonical left-to-right table order (persistence re-emits selections in this
 * order). Scoped to this page by CTO decision (the shared `ResourceTable` stays untouched).
 *
 * Grouped for a logical picker + table: the four original presentational columns, the ADR-0058 identity
 * columns (`manager`/`legajo`/`username`), then the two derived #386 activity counts.
 */
const HIDEABLE_COLUMNS = [
  "email",
  "role",
  "manager",
  "legajo",
  "username",
  "status",
  "assetsInPossession",
  "appAccesses",
  "updated",
] as const;
type HideableColumn = (typeof HIDEABLE_COLUMNS)[number];

/**
 * Column-picker grouping (#386) — purely presentational structure for the dropdown so a now-longer
 * list reads as three labelled sections: the original presentational columns, the ADR-0058 identity
 * columns, and the derived activity counts. The flattened union of `keys` MUST equal `HIDEABLE_COLUMNS`
 * (every hideable column appears in exactly one group); it drives only the menu, never visibility.
 */
const COLUMN_GROUPS: { id: string; keys: readonly HideableColumn[] }[] = [
  { id: "general", keys: ["email", "role", "status", "updated"] },
  { id: "identity", keys: ["manager", "legajo", "username"] },
  { id: "activity", keys: ["assetsInPossession", "appAccesses"] },
];

/** localStorage key persisting the visible hideable-column set (per browser). */
const COLUMNS_STORAGE_KEY = "lazyit:users:columns";

/**
 * The columns shown by default — the picker subtracts from (and now also adds to) this set. We keep the
 * lean #368 default (the original four presentational columns) so the table isn't noisy out of the box;
 * the five #386 columns (manager/legajo/username + the two counts) are OPT-IN, surfaced only when an
 * operator turns them on. Existing persisted sets (which only ever held a subset of the original four)
 * keep working unchanged.
 */
const DEFAULT_VISIBLE_COLUMNS: HideableColumn[] = [
  "email",
  "role",
  "status",
  "updated",
];

/**
 * A derived #386 activity count (assets-in-possession / app-accesses). The fields are OPTIONAL on the
 * list row — an ABSENT value means "this response didn't compute it" — so we coalesce absent → 0 and
 * render a muted "0" for "none" (zero or absent), keeping the real, non-zero counts in the normal
 * foreground so a busy user stands out. Right-alignment + `tabular-nums` lives on the cell.
 */
function CountCell({ value }: { value?: number }) {
  const count = value ?? 0;
  return count === 0 ? (
    <span className="text-muted-foreground">0</span>
  ) : (
    count
  );
}

export function UsersListView() {
  const t = useTranslations("users");
  const { date } = useFormatters();
  const tShared = useTranslations("shared");
  // User administration (create / edit / clone / role-change / offboard / restore) is the single
  // coarse `user:manage` capability on the backend. `isAdmin` still gates the archived (`deleted=only`)
  // slice, which the API keeps ADMIN-only.
  const { isAdmin } = usePermissions();
  const canManage = useCan("user:manage");
  const {
    q,
    sort,
    dir,
    offset,
    limit,
    filters,
    setQ,
    toggleSort,
    setFilter,
    setOffset,
    clearFilters,
    filtersActive,
  } = useListParams({
    filters: FILTER_DEFAULTS,
    defaultSort: "createdAt",
    defaultDir: "desc",
  });

  const statusFilter = filters.status as StatusFilter;
  // The archived view is ADMIN-only.
  const archived = isAdmin && filters.archived === "only";
  const directoryFilter = filters.directory as DirectoryFilter;
  // Map the three-way segmented filter to the server's optional `directoryOnly` slice (omit for "ALL").
  const directoryOnly =
    directoryFilter === "directory"
      ? true
      : directoryFilter === "accounts"
        ? false
        : undefined;

  // Forward only the server-supported params; `status` is filtered client-side over the page below.
  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useUserList({
      q: q || undefined,
      sort,
      dir: sort ? dir : undefined,
      limit,
      offset,
      deleted: archived ? "only" : undefined,
      directoryOnly,
    });
  const restoreUserMutation = useRestoreUser();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | undefined>(undefined);
  // The server-orchestrated clone wizard (ADR-0058) — distinct from the create/edit form dialog.
  const [cloning, setCloning] = useState<User | undefined>(undefined);
  const [deleting, setDeleting] = useState<User | undefined>(undefined);
  const [bulkRestoring, setBulkRestoring] = useState(false);

  const rows = useMemo(() => {
    const items = page?.items ?? [];
    if (statusFilter === "ALL") return items;
    return items.filter((user) =>
      statusFilter === "ACTIVE" ? user.isActive : !user.isActive,
    );
  }, [page?.items, statusFilter]);

  // Selection only matters in the archived view (its sole bulk action: Restore).
  const visibleIds = useMemo(() => rows.map((user) => user.id), [rows]);
  const selection = useRowSelection(visibleIds);
  const selectable = archived;

  // Per-browser column-picker state (#368). `mounted` gates the persisted set so SSR/first paint
  // always renders the lean `DEFAULT_VISIBLE_COLUMNS` (the server snapshot) — no hydration flash and,
  // post-#386, no flash of the opt-in columns before the persisted set resolves.
  const [storedColumns, setStoredColumns, columnsMounted] = useLocalStorage<
    HideableColumn[]
  >(COLUMNS_STORAGE_KEY, DEFAULT_VISIBLE_COLUMNS);
  // Defend against stale/garbage storage (renamed/removed keys, or a non-array shape from an older
  // build): only keep known hideable keys.
  const visibleColumns = useMemo(() => {
    if (!columnsMounted || !Array.isArray(storedColumns)) {
      return new Set<HideableColumn>(DEFAULT_VISIBLE_COLUMNS);
    }
    return new Set(storedColumns.filter((key) => HIDEABLE_COLUMNS.includes(key)));
  }, [columnsMounted, storedColumns]);
  const isColumnVisible = (key: HideableColumn) => visibleColumns.has(key);

  function toggleColumn(key: HideableColumn, visible: boolean) {
    setStoredColumns((prev) => {
      const kept = (Array.isArray(prev) ? prev : DEFAULT_VISIBLE_COLUMNS).filter(
        (k) => HIDEABLE_COLUMNS.includes(k),
      );
      if (visible) {
        if (kept.includes(key)) return kept;
        // Re-emit in canonical column order so persistence stays stable regardless of toggle order.
        return HIDEABLE_COLUMNS.filter((k) => k === key || kept.includes(k));
      }
      return kept.filter((k) => k !== key);
    });
  }

  function handleRestoreRow(user: User) {
    const name = `${user.firstName} ${user.lastName}`;
    restoreUserMutation.mutate(user.id, {
      onSuccess: () => toast.success(t("list.toast.restored", { name })),
      onError: (err) => notifyError(err, t("list.toast.restoreError")),
    });
  }

  /** Bulk restore via a per-id fan-out (no user batch endpoint exists). */
  async function handleBulkRestore() {
    setBulkRestoring(true);
    try {
      const result: BatchResult = await runPerIdBatch(
        selection.selectedIds,
        restoreUser,
      );
      notifyBatchResult(result, {
        entityKey: "user",
        verb: "restored",
        t: tShared,
      });
      selection.clear();
      await refetch();
    } catch (err) {
      notifyError(err, t("list.toast.bulkRestoreError"));
    } finally {
      setBulkRestoring(false);
    }
  }

  const columns = useMemo<ResourceColumn[]>(() => {
    // Entries are `ResourceColumn | false`; a hideable column collapses to `false` when toggled off
    // and is dropped below, so the rendered set always matches the persisted visible-column set.
    const defs: (ResourceColumn | false)[] = [
        {
          key: "avatar",
          header: t("list.columns.avatar"),
          srOnlyHeader: true,
          headClassName: "w-12",
          skeleton: <Skeleton className="size-8 rounded-full" />,
        },
        {
          key: "name",
          header: (
            <SortableHeader
              label={t("list.columns.name")}
              active={sort === "firstName"}
              direction={dir}
              onToggle={() => toggleSort("firstName")}
            />
          ),
          skeleton: <Skeleton className="h-4 w-32" />,
        },
        isColumnVisible("email") && {
          key: "email",
          header: (
            <SortableHeader
              label={t("list.columns.email")}
              active={sort === "email"}
              direction={dir}
              onToggle={() => toggleSort("email")}
            />
          ),
          skeleton: <Skeleton className="h-4 w-48" />,
        },
        isColumnVisible("role") && {
          key: "role",
          header: (
            <SortableHeader
              label={t("list.columns.role")}
              active={sort === "role"}
              direction={dir}
              onToggle={() => toggleSort("role")}
            />
          ),
          skeleton: <Skeleton className="h-8 w-[7.5rem] rounded-lg" />,
        },
        // ADR-0058 identity columns (#386). Not server-sortable here (sort allowlist is unchanged), so
        // plain text headers — no SortableHeader.
        isColumnVisible("manager") && {
          key: "manager",
          header: t("list.columns.manager"),
          skeleton: <Skeleton className="h-4 w-28" />,
        },
        isColumnVisible("legajo") && {
          key: "legajo",
          header: t("list.columns.legajo"),
          skeleton: <Skeleton className="h-4 w-20" />,
        },
        isColumnVisible("username") && {
          key: "username",
          header: t("list.columns.username"),
          skeleton: <Skeleton className="h-4 w-24" />,
        },
        isColumnVisible("status") && {
          key: "status",
          header: t("list.columns.status"),
          skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
        },
        // Derived #386 activity counts. Right-aligned numeric headers/cells; sorting is v1-out per the
        // issue, so plain (non-sortable) headers.
        isColumnVisible("assetsInPossession") && {
          key: "assetsInPossession",
          header: t("list.columns.assetsInPossession"),
          headClassName: "text-right",
          skeleton: <Skeleton className="ml-auto h-4 w-8" />,
        },
        isColumnVisible("appAccesses") && {
          key: "appAccesses",
          header: t("list.columns.appAccesses"),
          headClassName: "text-right",
          skeleton: <Skeleton className="ml-auto h-4 w-8" />,
        },
        isColumnVisible("updated") && {
          key: "updated",
          header: t("list.columns.updated"),
          skeleton: <Skeleton className="h-4 w-20" />,
        },
        {
          key: "actions",
          header: t("list.columns.actions"),
          srOnlyHeader: true,
          headClassName: "w-12 text-right",
          skeleton: <Skeleton className="ml-auto size-7" />,
        },
    ];
    return defs.filter((column): column is ResourceColumn => column !== false);
    // `visibleColumns` is the source of truth for which hideable columns appear; `isColumnVisible`
    // reads it, so depend on the set itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, dir, toggleSort, t, visibleColumns]);

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  function openEdit(user: User) {
    setEditing(user);
    setFormOpen(true);
  }

  /** Opens the clone wizard (its own dialog), not the create/edit form. */
  function openClone(user: User) {
    setCloning(user);
  }

  const chips = [
    ...(q
      ? [
          {
            key: "q",
            label: t("list.chips.search", { query: q }),
            onClear: () => setQ(""),
          },
        ]
      : []),
    ...(statusFilter !== "ALL"
      ? [
          {
            key: "status",
            label: t("list.chips.status", {
              status: t(`list.statusFilterLabel.${statusFilter}`),
            }),
            onClear: () => setFilter("status", FILTER_DEFAULTS.status),
          },
        ]
      : []),
    ...(directoryFilter !== "ALL"
      ? [
          {
            key: "directory",
            label: t("list.chips.directory", {
              directory: t(`list.directoryFilter.${directoryFilter}`),
            }),
            onClear: () => setFilter("directory", FILTER_DEFAULTS.directory),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("list.title")}
        pillar="manage"
        icon={UsersIcon}
        subtitle={t("list.subtitle")}
        actions={
          <>
            {isAdmin ? (
              <ArchivedToggle
                checked={archived}
                onCheckedChange={(on) => {
                  setFilter("archived", on ? "only" : FILTER_DEFAULTS.archived);
                  selection.clear();
                }}
              />
            ) : null}
            {canManage ? (
              <Button asChild>
                <Link href="/users/new">
                  <PlusIcon />
                  {t("list.newUser")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <ByoiBanner />

      {isLoading ? (
        <ResourceTable columns={columns} isLoading mobileChildren={<></>} />
      ) : isError ? (
        <ErrorState
          title={t("list.loadErrorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={UserPlusIcon}
          pillar="manage"
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            canManage
              ? { label: t("empty.action"), href: "/users/new" }
              : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput
              value={q}
              debounceMs={300}
              onDebouncedChange={setQ}
              label={t("list.searchLabel")}
              placeholder={t("list.searchPlaceholder")}
              className="sm:max-w-xs sm:flex-1"
            />
            <Select
              value={statusFilter}
              onValueChange={(value) => setFilter("status", value)}
            >
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("list.status.all")}</SelectItem>
                <SelectItem value="ACTIVE">{t("list.status.active")}</SelectItem>
                <SelectItem value="INACTIVE">
                  {t("list.status.inactive")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={directoryFilter}
              onValueChange={(value) => setFilter("directory", value)}
            >
              <SelectTrigger
                className="sm:w-44"
                aria-label={t("list.directoryFilter.label")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">
                  {t("list.directoryFilter.ALL")}
                </SelectItem>
                <SelectItem value="directory">
                  {t("list.directoryFilter.directory")}
                </SelectItem>
                <SelectItem value="accounts">
                  {t("list.directoryFilter.accounts")}
                </SelectItem>
              </SelectContent>
            </Select>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="sm:ml-auto"
                  aria-label={t("list.columnPicker.label")}
                  title={t("list.columnPicker.label")}
                >
                  <ViewColumnsIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel>
                  {t("list.columnPicker.label")}
                </DropdownMenuLabel>
                {COLUMN_GROUPS.map((group) => (
                  <div key={group.id}>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                      {t(`list.columnPicker.groups.${group.id}`)}
                    </DropdownMenuLabel>
                    {group.keys.map((key) => (
                      <DropdownMenuCheckboxItem
                        key={key}
                        checked={isColumnVisible(key)}
                        // Keep the menu open so several columns can be toggled in one pass.
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) => toggleColumn(key, checked)}
                      >
                        {t(`list.columnPicker.columns.${key}`)}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={
              archived
                ? t("list.filteredEmptyArchived")
                : t("list.filteredEmptyDefault")
            }
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            selection={
              selectable
                ? {
                    enabled: true,
                    allSelected: selection.allSelected,
                    someSelected: selection.someSelected,
                    onToggleAll: selection.toggleAll,
                    selectAllLabel: t("list.selectAllLabel"),
                  }
                : undefined
            }
            mobileChildren={rows.map((user) => (
              <ResourceCard
                key={user.id}
                href={`/users/${user.id}`}
                selectable={selectable}
                selected={selection.isSelected(user.id)}
                onSelectedChange={(on) => selection.setSelected(user.id, on)}
                selectLabel={t("list.selectLabel", {
                  name: `${user.firstName} ${user.lastName}`,
                })}
                title={
                  <span className="inline-flex items-center gap-2">
                    <UserAvatar
                      size="sm"
                      firstName={user.firstName}
                      lastName={user.lastName}
                      email={user.email}
                    />
                    {user.firstName} {user.lastName}
                    {user.directoryOnly && <UserDirectoryBadge />}
                  </span>
                }
                badge={<UserStatusBadge isActive={user.isActive} />}
                meta={
                  <>
                    <ResourceCardMeta
                      label={t("list.meta.email")}
                      className="col-span-2"
                    >
                      <span className="break-all">{user.email}</span>
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("list.meta.role")}>
                      <UserRoleSelect user={user} size="sm" />
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("list.meta.updated")}>
                      {date(user.updatedAt)}
                    </ResourceCardMeta>
                  </>
                }
                actions={
                  archived ? (
                    canManage ? (
                      <RestoreRowAction
                        onRestore={() => handleRestoreRow(user)}
                        disabled={restoreUserMutation.isPending}
                      />
                    ) : undefined
                  ) : canManage ? (
                    <RowActions
                      onEdit={() => openEdit(user)}
                      onClone={() => openClone(user)}
                      onDelete={() => setDeleting(user)}
                      deleteLabel={t("list.offboardAction")}
                    />
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((user) => {
              // Per-key body cells, keyed to the same column keys as the `columns` memo above. We
              // render by iterating `columns`, so a hidden column drops from the header AND the body
              // in lockstep — they can never drift. Structural keys (avatar/name/actions) are always
              // present here; the hideable ones simply won't be looked up when their column is off.
              const cells: Record<string, ReactNode> = {
                avatar: (
                  <TableCell key="avatar">
                    <UserAvatar
                      firstName={user.firstName}
                      lastName={user.lastName}
                      email={user.email}
                    />
                  </TableCell>
                ),
                name: (
                  <TableCell key="name" className="font-medium">
                    <span className="flex items-center gap-2">
                      <Link
                        href={`/users/${user.id}`}
                        className="hover:underline"
                      >
                        {user.firstName} {user.lastName}
                      </Link>
                      {user.directoryOnly && <UserDirectoryBadge />}
                    </span>
                  </TableCell>
                ),
                email: (
                  <TableCell key="email" className="text-muted-foreground">
                    {user.email}
                  </TableCell>
                ),
                role: (
                  <TableCell key="role">
                    <UserRoleSelect user={user} size="sm" />
                  </TableCell>
                ),
                manager: (
                  <TableCell key="manager">
                    <ManagerDisplay manager={user.manager} />
                  </TableCell>
                ),
                legajo: (
                  <TableCell key="legajo">
                    {user.legajo ? (
                      user.legajo
                    ) : (
                      <span className="text-muted-foreground">
                        {t("list.cells.empty")}
                      </span>
                    )}
                  </TableCell>
                ),
                username: (
                  <TableCell key="username">
                    {user.username ? (
                      user.username
                    ) : (
                      <span className="text-muted-foreground">
                        {t("list.cells.empty")}
                      </span>
                    )}
                  </TableCell>
                ),
                status: (
                  <TableCell key="status">
                    <UserStatusBadge isActive={user.isActive} />
                  </TableCell>
                ),
                assetsInPossession: (
                  <TableCell
                    key="assetsInPossession"
                    className="text-right tabular-nums"
                  >
                    <CountCell value={user.assetsInPossession} />
                  </TableCell>
                ),
                appAccesses: (
                  <TableCell
                    key="appAccesses"
                    className="text-right tabular-nums"
                  >
                    <CountCell value={user.appAccesses} />
                  </TableCell>
                ),
                updated: (
                  <TableCell
                    key="updated"
                    className="text-muted-foreground tabular-nums"
                  >
                    {date(user.updatedAt)}
                  </TableCell>
                ),
                actions: (
                  <TableCell key="actions" className="text-right">
                    {archived ? (
                      canManage ? (
                        <div className="flex justify-end">
                          <RestoreRowAction
                            onRestore={() => handleRestoreRow(user)}
                            disabled={restoreUserMutation.isPending}
                          />
                        </div>
                      ) : null
                    ) : canManage ? (
                      <div className={cn("flex justify-end", rowActionsReveal)}>
                        <RowActions
                          onEdit={() => openEdit(user)}
                          onClone={() => openClone(user)}
                          onDelete={() => setDeleting(user)}
                          deleteLabel={t("list.offboardAction")}
                        />
                      </div>
                    ) : null}
                  </TableCell>
                ),
              };
              return (
                <LinkableRow
                  key={user.id}
                  href={`/users/${user.id}`}
                  data-state={
                    selectable && selection.isSelected(user.id)
                      ? "selected"
                      : undefined
                  }
                >
                  {selectable ? (
                    <SelectCell
                      checked={selection.isSelected(user.id)}
                      onCheckedChange={(on) =>
                        selection.setSelected(user.id, on)
                      }
                      label={t("list.selectLabel", {
                        name: `${user.firstName} ${user.lastName}`,
                      })}
                    />
                  ) : null}
                  {columns.map((column) => cells[column.key])}
                </LinkableRow>
              );
            })}
          </ResourceTable>

          {archived ? (
            <BatchActionBar
              count={selection.count}
              onClear={selection.clear}
              entityKey="user"
            >
              <Button
                size="sm"
                onClick={handleBulkRestore}
                disabled={bulkRestoring}
              >
                <ArrowUturnLeftIcon />
                {t("list.restore")}
              </Button>
            </BatchActionBar>
          ) : null}

          <Pagination
            total={total}
            limit={page?.limit ?? limit}
            offset={page?.offset ?? offset}
            itemCount={page?.items.length ?? 0}
            onOffsetChange={setOffset}
            isFetching={isFetching}
          />
        </>
      )}

      <UserFormDialog
        key={editing ? `edit-${editing.id}` : "create"}
        open={formOpen}
        onOpenChange={setFormOpen}
        user={editing}
      />
      {cloning ? (
        <CloneUserWizard
          key={`clone-${cloning.id}`}
          open
          onOpenChange={(open) => {
            if (!open) setCloning(undefined);
          }}
          source={cloning}
        />
      ) : null}
      {deleting ? (
        <OffboardingSheet
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          user={deleting}
        />
      ) : null}
    </div>
  );
}
