"use client";

import { KeyIcon, PlusIcon } from "@heroicons/react/24/outline";
import { MAX_PAGE_LIMIT, type User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  LinkableRow,
  Pagination,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
  RowActions,
  rowActionsReveal,
  SortableHeader,
} from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
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
import { useAccessGrants } from "@/lib/api/hooks/use-access-grants";
import { useApplicationCategories } from "@/lib/api/hooks/use-application-categories";
import { useApplicationList } from "@/lib/api/hooks/use-applications";
import { useDeleteApplication } from "@/lib/api/hooks/use-application-mutations";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { cn } from "@/lib/utils";
import { StackedUserAvatars } from "./stacked-user-avatars";

type CriticalityFilter = "ALL" | "CRITICAL" | "NORMAL";

/**
 * Filter param defaults. `category` and `criticality` are filtered client-side over the page (the
 * Access API has no category/criticality params — it already joins category + grants client-side).
 */
const FILTER_DEFAULTS = { category: "ALL", criticality: "ALL" } as const;

/** Stable empty placeholder for the loading skeleton's mobile children slot. */
const LOADING_MOBILE_CHILDREN = <></>;


export function ApplicationsListView() {
  const t = useTranslations("applications");
  const { date } = useFormatters();
  const router = useRouter();
  const canWrite = useCan("application:write");
  const canDelete = useCan("application:delete");
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
    defaultSort: "name",
    defaultDir: "asc",
  });

  const categoryFilter = filters.category;
  const criticality = filters.criticality as CriticalityFilter;

  const criticalityLabel: Record<CriticalityFilter, string> = {
    ALL: t("list.criticalityAny"),
    CRITICAL: t("list.criticalOnly"),
    NORMAL: t("list.nonCritical"),
  };

  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useApplicationList({
      q: q || undefined,
      sort,
      dir: sort ? dir : undefined,
      limit,
      offset,
    });
  const { data: categories } = useApplicationCategories();
  // All active grants across apps + the full user directory — joined client-side for the
  // counts/avatars (ADR-0020). The counts must see every active grant, so we request the hard-max
  // page (200); the Access list itself is per-application, so this dedicated count read stays
  // unpaginated.
  const { data: activeGrantsPage } = useAccessGrants({
    activeOnly: true,
    limit: MAX_PAGE_LIMIT,
  });
  const activeGrants = activeGrantsPage?.items;
  const { data: users } = useUsers();
  const deleteApplication = useDeleteApplication();

  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  );

  const categoryNameById = useMemo(
    () =>
      new Map((categories ?? []).map((category) => [category.id, category.name])),
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

  const rows = useMemo(() => {
    const items = page?.items ?? [];
    return items.filter((application) => {
      if (categoryFilter !== "ALL" && application.categoryId !== categoryFilter)
        return false;
      if (criticality === "CRITICAL" && !application.isCritical) return false;
      if (criticality === "NORMAL" && application.isCritical) return false;
      return true;
    });
  }, [page?.items, categoryFilter, criticality]);

  const columns = useMemo<ResourceColumn[]>(
    () => [
      {
        key: "name",
        header: (
          <SortableHeader
            label={t("list.columns.name")}
            active={sort === "name"}
            direction={dir}
            onToggle={() => toggleSort("name")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-32" />,
      },
      {
        key: "vendor",
        header: (
          <SortableHeader
            label={t("list.columns.vendor")}
            active={sort === "vendor"}
            direction={dir}
            onToggle={() => toggleSort("vendor")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-24" />,
      },
      {
        key: "category",
        header: t("list.columns.category"),
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        key: "critical",
        header: (
          <SortableHeader
            label={t("list.columns.critical")}
            active={sort === "isCritical"}
            direction={dir}
            onToggle={() => toggleSort("isCritical")}
          />
        ),
        skeleton: <Skeleton className="h-5 w-14 rounded-full" />,
      },
      {
        key: "grants",
        header: t("list.columns.activeAccess"),
        skeleton: <Skeleton className="size-6 rounded-full" />,
      },
      {
        key: "updated",
        header: (
          <SortableHeader
            label={t("list.columns.updated")}
            active={sort === "updatedAt"}
            direction={dir}
            onToggle={() => toggleSort("updatedAt")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "actions",
        header: t("list.columns.actions"),
        srOnlyHeader: true,
        headClassName: "w-12 text-right",
        skeleton: <Skeleton className="ml-auto size-7" />,
      },
    ],
    [sort, dir, toggleSort, t],
  );

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  /** Resolve the grantee avatars/count for one application from the client-side join. */
  function accessFor(applicationId: string) {
    const access = accessByApp.get(applicationId);
    const granteeUsers = access
      ? [...access.userIds]
          .map((id) => userById.get(id))
          .filter((user): user is User => user != null)
      : [];
    // Distinct grantees with an active grant whose user row is soft-deleted (hence absent from the
    // active-users read) — flagged as a dimmed placeholder chip, not dropped.
    const deactivatedGrantees = access
      ? [...access.userIds].filter((id) => !userById.has(id)).length
      : 0;
    return { count: access?.count ?? 0, granteeUsers, deactivatedGrantees };
  }

  function categoryBadge(categoryId: string | null) {
    return categoryId && categoryNameById.has(categoryId) ? (
      <Badge variant="outline">{categoryNameById.get(categoryId)}</Badge>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }

  const chips = [
    ...(q
      ? [{ key: "q", label: t("list.chips.search", { q }), onClear: () => setQ("") }]
      : []),
    ...(categoryFilter !== "ALL"
      ? [
          {
            key: "category",
            label: t("list.chips.category", {
              name: categoryNameById.get(categoryFilter) ?? "—",
            }),
            onClear: () => setFilter("category", FILTER_DEFAULTS.category),
          },
        ]
      : []),
    ...(criticality !== "ALL"
      ? [
          {
            key: "criticality",
            label: t("list.chips.criticality", {
              value: criticalityLabel[criticality],
            }),
            onClear: () => setFilter("criticality", FILTER_DEFAULTS.criticality),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("list.title")}
        pillar="access"
        icon={KeyIcon}
        subtitle={t("list.subtitle")}
        actions={
          canWrite ? (
            <Button asChild>
              <Link href="/applications/new">
                <PlusIcon />
                {t("list.newApplication")}
              </Link>
            </Button>
          ) : null
        }
      />

      {isLoading ? (
        <ResourceTable columns={columns} isLoading mobileChildren={LOADING_MOBILE_CHILDREN} />
      ) : isError ? (
        <ErrorState
          title={t("list.errorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={KeyIcon}
          pillar="access"
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            canWrite
              ? { label: t("empty.action"), href: "/applications/new" }
              : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
            <SearchInput
              value={q}
              debounceMs={300}
              onDebouncedChange={setQ}
              label={t("list.searchLabel")}
              placeholder={t("list.searchPlaceholder")}
              className="lg:max-w-xs lg:flex-1"
            />
            <Select
              value={categoryFilter}
              onValueChange={(value) => setFilter("category", value)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("list.allCategories")}</SelectItem>
                {(categories ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={criticality}
              onValueChange={(value) => setFilter("criticality", value)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("list.anyCriticality")}</SelectItem>
                <SelectItem value="CRITICAL">{t("list.criticalOnly")}</SelectItem>
                <SelectItem value="NORMAL">{t("list.nonCritical")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={t("list.filteredEmpty")}
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            mobileChildren={rows.map((application) => {
              const { count, granteeUsers, deactivatedGrantees } = accessFor(
                application.id,
              );
              return (
                <ResourceCard
                  key={application.id}
                  href={`/applications/${application.id}`}
                  title={application.name}
                  badge={
                    application.isCritical ? (
                      <Badge variant="destructive">
                        {t("list.criticalBadge")}
                      </Badge>
                    ) : undefined
                  }
                  meta={
                    <>
                      <ResourceCardMeta label={t("list.columns.vendor")}>
                        {application.vendor ?? "—"}
                      </ResourceCardMeta>
                      <ResourceCardMeta label={t("list.columns.category")}>
                        {categoryBadge(application.categoryId)}
                      </ResourceCardMeta>
                      <ResourceCardMeta label={t("list.columns.activeAccess")}>
                        {count === 0 ? (
                          "—"
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <StackedUserAvatars
                              users={granteeUsers}
                              deactivatedCount={deactivatedGrantees}
                            />
                            <span className="tabular-nums text-muted-foreground">
                              {count}
                            </span>
                          </span>
                        )}
                      </ResourceCardMeta>
                      <ResourceCardMeta label={t("list.columns.updated")}>
                        {date(application.updatedAt)}
                      </ResourceCardMeta>
                    </>
                  }
                  actions={
                    canWrite || canDelete ? (
                      <RowActions
                        onEdit={
                          canWrite
                            ? () =>
                                router.push(
                                  `/applications/${application.id}/edit`,
                                )
                            : undefined
                        }
                        onClone={
                          canWrite
                            ? () =>
                                router.push(
                                  `/applications/${application.id}/clone`,
                                )
                            : undefined
                        }
                        onDelete={
                          canDelete
                            ? () =>
                                setDeleting({
                                  id: application.id,
                                  name: application.name,
                                })
                            : undefined
                        }
                      />
                    ) : undefined
                  }
                />
              );
            })}
          >
            {rows.map((application) => {
              const { count, granteeUsers, deactivatedGrantees } = accessFor(
                application.id,
              );
              return (
                <LinkableRow
                  key={application.id}
                  href={`/applications/${application.id}`}
                >
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
                  <TableCell>{categoryBadge(application.categoryId)}</TableCell>
                  <TableCell>
                    {application.isCritical ? (
                      <Badge variant="destructive">
                        {t("list.criticalBadge")}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {count === 0 ? (
                      <span className="text-sm text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <StackedUserAvatars
                          users={granteeUsers}
                          deactivatedCount={deactivatedGrantees}
                        />
                        <span className="text-sm text-muted-foreground tabular-nums">
                          {count}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {date(application.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {canWrite || canDelete ? (
                      <div className={cn("flex justify-end", rowActionsReveal)}>
                        <RowActions
                          onEdit={
                            canWrite
                              ? () =>
                                  router.push(
                                    `/applications/${application.id}/edit`,
                                  )
                              : undefined
                          }
                          onClone={
                            canWrite
                              ? () =>
                                  router.push(
                                    `/applications/${application.id}/clone`,
                                  )
                              : undefined
                          }
                          onDelete={
                            canDelete
                              ? () =>
                                  setDeleting({
                                    id: application.id,
                                    name: application.name,
                                  })
                              : undefined
                          }
                        />
                      </div>
                    ) : null}
                  </TableCell>
                </LinkableRow>
              );
            })}
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

      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          entityKey="application"
          name={deleting.name}
          onConfirm={() => deleteApplication.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
