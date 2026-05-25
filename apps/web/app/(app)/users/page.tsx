"use client";

import {
  ArrowPathIcon,
  EllipsisVerticalIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import { useMemo, useState } from "react";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useUsers } from "@/lib/api/hooks/use-users";
import { DeleteUserDialog } from "./_components/delete-user-dialog";
import { UserFormDialog } from "./_components/user-form-dialog";
import { UserStatusBadge } from "./_components/user-status-badge";

type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE";

export default function UsersPage() {
  const { data: users, isLoading, isError, refetch } = useUsers();

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
        <TableShell>
          <SkeletonRows />
        </TableShell>
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !hasData ? (
        <EmptyState onCreate={openCreate} />
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

          <TableShell>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="h-24 text-center text-muted-foreground"
                >
                  No users match your filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((user) => (
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
              ))
            )}
          </TableShell>
        </>
      )}

      <UserFormDialog
        key={editing ? `edit-${editing.id}` : "create"}
        open={formOpen}
        onOpenChange={setFormOpen}
        user={editing}
      />
      {deleting ? (
        <DeleteUserDialog
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

const COLUMN_COUNT = 6;
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e"] as const;

/** Bordered container + shared header for the users table. */
function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <span className="sr-only">Avatar</span>
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="w-12 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {SKELETON_ROW_KEYS.map((key) => (
        <TableRow key={key}>
          <TableCell>
            <Skeleton className="size-8 rounded-full" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-32" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-48" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-16 rounded-full" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-20" />
          </TableCell>
          <TableCell>
            <Skeleton className="ml-auto size-7" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function RowActions({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open actions">
          <EllipsisVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      {/* Dialogs are opened via page state (siblings of the menu), not nested
          here — the documented Radix way to avoid focus/pointer-event locks. */}
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onSelect={onEdit}>
          <PencilSquareIcon />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <TrashIcon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <UserPlusIcon className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No users yet</p>
        <p className="text-sm text-muted-foreground">
          Add your first user to start tracking who is in your organization.
        </p>
      </div>
      <Button onClick={onCreate}>
        <PlusIcon />
        Create your first user
      </Button>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <p className="text-sm font-medium">Could not load users</p>
      <p className="text-sm text-muted-foreground">
        The API may be down or unreachable.
      </p>
      <Button variant="outline" onClick={onRetry}>
        <ArrowPathIcon />
        Retry
      </Button>
    </div>
  );
}

/** ISO string → short local date for the "Updated" column. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
