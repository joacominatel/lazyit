"use client";

import { PlusIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageHeader } from "@/components/page-header";
import {
  EmptyState,
  ErrorState,
  Pagination,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
  RowActions,
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
import { TableCell, TableRow } from "@/components/ui/table";
import { UserAvatar } from "@/components/user-avatar";
import { useUserList } from "@/lib/api/hooks/use-users";
import { useDeleteUser } from "@/lib/api/hooks/use-user-mutations";
import { useCanWrite } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { formatDate } from "@/lib/utils/format";
import { ByoiBanner } from "./_components/byoi-banner";
import { UserFormDialog } from "./_components/user-form-dialog";
import { UserRoleSelect } from "./_components/user-role-select";
import { UserStatusBadge } from "./_components/user-status-badge";

type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE";

/** Filter param defaults. `status` (active/inactive) is filtered client-side over the page. */
const FILTER_DEFAULTS = { status: "ALL" } as const;

const STATUS_LABEL: Record<StatusFilter, string> = {
  ALL: "All",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};

export default function UsersPage() {
  const canWrite = useCanWrite();
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

  // Forward only the server-supported params; `status` is filtered client-side over the page below.
  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useUserList({
      q: q || undefined,
      sort,
      dir: sort ? dir : undefined,
      limit,
      offset,
    });
  const deleteUser = useDeleteUser();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | undefined>(undefined);
  const [deleting, setDeleting] = useState<User | undefined>(undefined);

  const rows = useMemo(() => {
    const items = page?.items ?? [];
    if (statusFilter === "ALL") return items;
    return items.filter((user) =>
      statusFilter === "ACTIVE" ? user.isActive : !user.isActive,
    );
  }, [page?.items, statusFilter]);

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
    setFormOpen(true);
  }

  function openEdit(user: User) {
    setEditing(user);
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
        subtitle="The people in your organization."
        actions={
          canWrite ? (
            <Button onClick={openCreate}>
              <PlusIcon />
              New user
            </Button>
          ) : null
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
          title="No users yet"
          description="Add your first user to start tracking who is in your organization."
          action={
            canWrite ? (
              <Button onClick={openCreate}>
                <PlusIcon />
                Create your first user
              </Button>
            ) : undefined
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
            filteredEmptyMessage="No users match your filters."
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            mobileChildren={rows.map((user) => (
              <ResourceCard
                key={user.id}
                href={`/users/${user.id}`}
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
                  canWrite ? (
                    <RowActions
                      onEdit={() => openEdit(user)}
                      onDelete={() => setDeleting(user)}
                    />
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((user) => (
              <TableRow key={user.id}>
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
                  {canWrite ? (
                    <RowActions
                      onEdit={() => openEdit(user)}
                      onDelete={() => setDeleting(user)}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </ResourceTable>

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
      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          entityLabel="user"
          name={`${deleting.firstName} ${deleting.lastName}`}
          onConfirm={() => deleteUser.mutateAsync(deleting.id)}
        >
          To keep a person on record but disable them, set them inactive instead.
        </DeleteConfirmDialog>
      ) : null}
    </div>
  );
}
