"use client";

import {
  MagnifyingGlassIcon,
  PlusIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  EmptyState,
  ErrorState,
  type ResourceColumn,
  ResourceTable,
  RowActions,
} from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useDeleteUser } from "@/lib/api/hooks/use-user-mutations";
import { useUsers } from "@/lib/api/hooks/use-users";
import { formatDate } from "@/lib/utils/format";
import { UserFormDialog } from "./_components/user-form-dialog";
import { UserStatusBadge } from "./_components/user-status-badge";

type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE";

const COLUMNS: ResourceColumn[] = [
  {
    key: "avatar",
    header: "Avatar",
    srOnlyHeader: true,
    headClassName: "w-12",
    skeleton: <Skeleton className="size-8 rounded-full" />,
  },
  { key: "name", header: "Name", skeleton: <Skeleton className="h-4 w-32" /> },
  { key: "email", header: "Email", skeleton: <Skeleton className="h-4 w-48" /> },
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
];

export default function UsersPage() {
  const { data: users, isLoading, isError, error, refetch } = useUsers();
  const deleteUser = useDeleteUser();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | undefined>(undefined);
  const [deleting, setDeleting] = useState<User | undefined>(undefined);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (users ?? []).filter((user) => {
      const matchesStatus =
        statusFilter === "ALL" ||
        (statusFilter === "ACTIVE" ? user.isActive : !user.isActive);
      const haystack =
        `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase();
      const matchesSearch = query === "" || haystack.includes(query);
      return matchesStatus && matchesSearch;
    });
  }, [users, search, statusFilter]);

  const hasData = (users?.length ?? 0) > 0;

  function openCreate() {
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(user: User) {
    setEditing(user);
    setFormOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            The people in your organization.
          </p>
        </div>
        <Button onClick={openCreate}>
          <PlusIcon />
          New user
        </Button>
      </div>

      {isLoading ? (
        <ResourceTable columns={COLUMNS} isLoading />
      ) : isError ? (
        <ErrorState
          title="Could not load users"
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <EmptyState
          icon={UserPlusIcon}
          title="No users yet"
          description="Add your first user to start tracking who is in your organization."
          action={
            <Button onClick={openCreate}>
              <PlusIcon />
              Create your first user
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative sm:max-w-xs sm:flex-1">
              <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name or email…"
                className="pl-8"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as StatusFilter)}
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

          <ResourceTable
            columns={COLUMNS}
            isFilteredEmpty={filtered.length === 0}
            filteredEmptyMessage="No users match your filters."
          >
            {filtered.map((user) => (
              <TableRow key={user.id}>
                <TableCell>
                  <UserAvatar
                    firstName={user.firstName}
                    lastName={user.lastName}
                    email={user.email}
                  />
                </TableCell>
                <TableCell className="font-medium">
                  {user.firstName} {user.lastName}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {user.email}
                </TableCell>
                <TableCell>
                  <UserStatusBadge isActive={user.isActive} />
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDate(user.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <RowActions
                    onEdit={() => openEdit(user)}
                    onDelete={() => setDeleting(user)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </ResourceTable>
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
          To keep a person on record but disable them, set them inactive
          instead.
        </DeleteConfirmDialog>
      ) : null}
    </div>
  );
}
