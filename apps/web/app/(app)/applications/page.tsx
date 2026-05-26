"use client";

import { KeyIcon, MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  EmptyState,
  ErrorState,
  type ResourceColumn,
  ResourceTable,
  RowActions,
} from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
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
import { useAccessGrants } from "@/lib/api/hooks/use-access-grants";
import { useApplicationCategories } from "@/lib/api/hooks/use-application-categories";
import { useDeleteApplication } from "@/lib/api/hooks/use-application-mutations";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { formatDate } from "@/lib/utils/format";
import { StackedUserAvatars } from "./_components/stacked-user-avatars";

type CriticalityFilter = "ALL" | "CRITICAL" | "NORMAL";

const COLUMNS: ResourceColumn[] = [
  { key: "name", header: "Name", skeleton: <Skeleton className="h-4 w-32" /> },
  { key: "vendor", header: "Vendor", skeleton: <Skeleton className="h-4 w-24" /> },
  {
    key: "category",
    header: "Category",
    skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
  },
  {
    key: "critical",
    header: "Critical",
    skeleton: <Skeleton className="h-5 w-14 rounded-full" />,
  },
  {
    key: "grants",
    header: "Active access",
    skeleton: <Skeleton className="size-6 rounded-full" />,
  },
  { key: "updated", header: "Updated", skeleton: <Skeleton className="h-4 w-20" /> },
  {
    key: "actions",
    header: "Actions",
    srOnlyHeader: true,
    headClassName: "w-12 text-right",
    skeleton: <Skeleton className="ml-auto size-7" />,
  },
];

export default function ApplicationsPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [criticality, setCriticality] = useState<CriticalityFilter>("ALL");
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  );

  const debouncedSearch = useDebouncedValue(search.trim().toLowerCase(), 300);

  const {
    data: applications,
    isLoading,
    isError,
    error,
    refetch,
  } = useApplications();
  const { data: categories } = useApplicationCategories();
  // All active grants across apps + all users — joined client-side for the counts/avatars (ADR-0020).
  const { data: activeGrants } = useAccessGrants({ activeOnly: true });
  const { data: users } = useUsers();
  const deleteApplication = useDeleteApplication();

  const categoryNameById = useMemo(
    () => new Map((categories ?? []).map((category) => [category.id, category.name])),
    [categories],
  );
  const userById = useMemo(
    () => new Map<string, User>((users ?? []).map((user) => [user.id, user])),
    [users],
  );
  // applicationId → { count of active grants, distinct grantee users }.
  const accessByApp = useMemo(() => {
    const map = new Map<string, { count: number; userIds: Set<string> }>();
    for (const grant of activeGrants ?? []) {
      const entry = map.get(grant.applicationId) ?? {
        count: 0,
        userIds: new Set<string>(),
      };
      entry.count += 1;
      entry.userIds.add(grant.userId);
      map.set(grant.applicationId, entry);
    }
    return map;
  }, [activeGrants]);

  const filtered = useMemo(
    () =>
      (applications ?? []).filter((application) => {
        if (
          debouncedSearch &&
          !application.name.toLowerCase().includes(debouncedSearch) &&
          !(application.vendor ?? "").toLowerCase().includes(debouncedSearch)
        )
          return false;
        if (categoryFilter !== "ALL" && application.categoryId !== categoryFilter)
          return false;
        if (criticality === "CRITICAL" && !application.isCritical) return false;
        if (criticality === "NORMAL" && application.isCritical) return false;
        return true;
      }),
    [applications, debouncedSearch, categoryFilter, criticality],
  );

  const filtersActive =
    debouncedSearch !== "" || categoryFilter !== "ALL" || criticality !== "ALL";
  const isEmpty = (applications?.length ?? 0) === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Access</h1>
          <p className="text-sm text-muted-foreground">
            Applications your team grants access to — who can reach what.
          </p>
        </div>
        <Button asChild>
          <Link href="/applications/new">
            <PlusIcon />
            New application
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <ResourceTable columns={COLUMNS} isLoading />
      ) : isError ? (
        <ErrorState
          title="Could not load applications"
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={KeyIcon}
          title="No applications yet"
          description="Add the SaaS products, systems and services your team grants access to."
          action={
            <Button asChild>
              <Link href="/applications/new">
                <PlusIcon />
                Create your first application
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
            <div className="relative lg:max-w-xs lg:flex-1">
              <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name or vendor…"
                className="pl-8"
              />
            </div>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All categories</SelectItem>
                {(categories ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={criticality}
              onValueChange={(value) =>
                setCriticality(value as CriticalityFilter)
              }
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Any criticality</SelectItem>
                <SelectItem value="CRITICAL">Critical only</SelectItem>
                <SelectItem value="NORMAL">Non-critical</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ResourceTable
            columns={COLUMNS}
            isFilteredEmpty={filtered.length === 0}
            filteredEmptyMessage="No applications match your filters."
          >
            {filtered.map((application) => {
              const access = accessByApp.get(application.id);
              const granteeUsers = access
                ? [...access.userIds]
                    .map((id) => userById.get(id))
                    .filter((user): user is User => user != null)
                : [];
              const count = access?.count ?? 0;
              return (
                <TableRow key={application.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/applications/${application.id}`}
                      className="hover:underline"
                    >
                      {application.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {application.vendor ?? "—"}
                  </TableCell>
                  <TableCell>
                    {application.categoryId &&
                    categoryNameById.has(application.categoryId) ? (
                      <Badge variant="outline">
                        {categoryNameById.get(application.categoryId)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {application.isCritical ? (
                      <Badge variant="destructive">Critical</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {count === 0 ? (
                      <span className="text-sm text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <StackedUserAvatars users={granteeUsers} />
                        <span className="text-sm text-muted-foreground tabular-nums">
                          {count}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {formatDate(application.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions
                      onEdit={() =>
                        router.push(`/applications/${application.id}/edit`)
                      }
                      onDelete={() =>
                        setDeleting({
                          id: application.id,
                          name: application.name,
                        })
                      }
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </ResourceTable>
        </>
      )}

      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          entityLabel="application"
          name={deleting.name}
          onConfirm={() => deleteApplication.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
