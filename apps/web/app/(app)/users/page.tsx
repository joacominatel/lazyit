"use client";

import {
  ArrowUturnLeftIcon,
  PlusIcon,
  UserPlusIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { BatchResult, User } from "@lazyit/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
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
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils/format";
import { ByoiBanner } from "./_components/byoi-banner";
import { OffboardingSheet } from "./_components/offboarding-sheet";
import { UserFormDialog } from "./_components/user-form-dialog";
import { UserRoleSelect } from "./_components/user-role-select";
import { UserStatusBadge } from "./_components/user-status-badge";

type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE";

/**
 * Filter param defaults. `status` (active/inactive) is filtered client-side over the page.
 * `archived` ("ALL" | "only") drives the ADMIN-only `deleted=only` view via the URL.
 */
const FILTER_DEFAULTS = { status: "ALL", archived: "ALL" } as const;

const STATUS_LABEL: Record<StatusFilter, string> = {
  ALL: "All",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};

export default function UsersPage() {
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

  // Forward only the server-supported params; `status` is filtered client-side over the page below.
  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useUserList({
      q: q || undefined,
      sort,
      dir: sort ? dir : undefined,
      limit,
      offset,
      deleted: archived ? "only" : undefined,
    });
  const restoreUserMutation = useRestoreUser();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | undefined>(undefined);
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

  function handleRestoreRow(user: User) {
    const name = `${user.firstName} ${user.lastName}`;
    restoreUserMutation.mutate(user.id, {
      onSuccess: () => toast.success(`${name} restored`),
      onError: (err) => notifyError(err, "Couldn't restore the user"),
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
      notifyBatchResult(result, { noun: "user", verb: "restored" });
      selection.clear();
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't restore the selected users");
    } finally {
      setBulkRestoring(false);
    }
  }

  const columns = useMemo<ResourceColumn[]>(
    () => [
      {
        key: "avatar",
        header: "Avatar",
        srOnlyHeader: true,
        headClassName: "w-12",
        skeleton: <Skeleton className="size-8 rounded-full" />,
      },
      {
        key: "name",
        header: (
          <SortableHeader
            label="Name"
            active={sort === "firstName"}
            direction={dir}
            onToggle={() => toggleSort("firstName")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-32" />,
      },
      {
        key: "email",
        header: (
          <SortableHeader
            label="Email"
            active={sort === "email"}
            direction={dir}
            onToggle={() => toggleSort("email")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-48" />,
      },
      {
        key: "role",
        header: (
          <SortableHeader
            label="Role"
            active={sort === "role"}
            direction={dir}
            onToggle={() => toggleSort("role")}
          />
        ),
        skeleton: <Skeleton className="h-8 w-[7.5rem] rounded-lg" />,
      },
      {
        key: "status",
        header: "Status",
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        key: "updated",
        header: "Updated",
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        headClassName: "w-12 text-right",
        skeleton: <Skeleton className="ml-auto size-7" />,
      },
    ],
    [sort, dir, toggleSort],
  );

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  function openCreate() {
    setEditing(undefined);
    setCloning(undefined);
    setFormOpen(true);
  }

  function openEdit(user: User) {
    setCloning(undefined);
    setEditing(user);
    setFormOpen(true);
  }

  function openClone(user: User) {
    setEditing(undefined);
    setCloning(user);
    setFormOpen(true);
  }

  const chips = [
    ...(q ? [{ key: "q", label: `Search: “${q}”`, onClear: () => setQ("") }] : []),
    ...(statusFilter !== "ALL"
      ? [
          {
            key: "status",
            label: `Status: ${STATUS_LABEL[statusFilter]}`,
            onClear: () => setFilter("status", FILTER_DEFAULTS.status),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        pillar="manage"
        icon={UsersIcon}
        subtitle="The people in your organization."
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
              <Button onClick={openCreate}>
                <PlusIcon />
                New user
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
          title="Could not load users"
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={UserPlusIcon}
          pillar="manage"
          title="No people here yet"
          description="Add the people in your organization — once they're here you can assign assets and grant them access."
          action={
            canManage
              ? { label: "Add your first user", onClick: openCreate }
              : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput
              value={q}
              onChange={setQ}
              debounceMs={300}
              onDebouncedChange={setQ}
              label="Search users"
              placeholder="Search by name or email…"
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
                <SelectItem value="ALL">All statuses</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={
              archived ? "No archived users." : "No users match your filters."
            }
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            selection={
              selectable
                ? {
                    enabled: true,
                    allSelected: selection.allSelected,
                    someSelected: selection.someSelected,
                    onToggleAll: selection.toggleAll,
                    selectAllLabel: "Select all users on this page",
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
                selectLabel={`Select ${user.firstName} ${user.lastName}`}
                title={
                  <span className="inline-flex items-center gap-2">
                    <UserAvatar
                      size="sm"
                      firstName={user.firstName}
                      lastName={user.lastName}
                      email={user.email}
                    />
                    {user.firstName} {user.lastName}
                  </span>
                }
                badge={<UserStatusBadge isActive={user.isActive} />}
                meta={
                  <>
                    <ResourceCardMeta label="Email" className="col-span-2">
                      <span className="break-all">{user.email}</span>
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Role">
                      <UserRoleSelect user={user} size="sm" />
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Updated">
                      {formatDate(user.updatedAt)}
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
                      deleteLabel="Offboard"
                    />
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((user) => (
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
                    onCheckedChange={(on) => selection.setSelected(user.id, on)}
                    label={`Select ${user.firstName} ${user.lastName}`}
                  />
                ) : null}
                <TableCell>
                  <UserAvatar
                    firstName={user.firstName}
                    lastName={user.lastName}
                    email={user.email}
                  />
                </TableCell>
                <TableCell className="font-medium">
                  <Link href={`/users/${user.id}`} className="hover:underline">
                    {user.firstName} {user.lastName}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {user.email}
                </TableCell>
                <TableCell>
                  <UserRoleSelect user={user} size="sm" />
                </TableCell>
                <TableCell>
                  <UserStatusBadge isActive={user.isActive} />
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDate(user.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
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
                        deleteLabel="Offboard"
                      />
                    </div>
                  ) : null}
                </TableCell>
              </LinkableRow>
            ))}
          </ResourceTable>

          {archived ? (
            <BatchActionBar
              count={selection.count}
              onClear={selection.clear}
              noun="user"
            >
              <Button
                size="sm"
                onClick={handleBulkRestore}
                disabled={bulkRestoring}
              >
                <ArrowUturnLeftIcon />
                Restore
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
        key={
          editing
            ? `edit-${editing.id}`
            : cloning
              ? `clone-${cloning.id}`
              : "create"
        }
        open={formOpen}
        onOpenChange={setFormOpen}
        user={editing}
        cloneSource={cloning}
      />
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
