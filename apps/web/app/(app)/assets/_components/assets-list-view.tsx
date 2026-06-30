"use client";

import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  FunnelIcon,
  PlusIcon,
  ServerStackIcon,
  ShareIcon,
  TrashIcon,
  UserMinusIcon,
  UserPlusIcon,
  ViewColumnsIcon,
} from "@heroicons/react/24/outline";
import {
  type AssetListItem,
  type AssetStatus,
  AssetStatusSchema,
  type BatchResult,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { ArchivedToggle } from "@/components/archived-toggle";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
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
  rowActionsReveal,
  SelectCell,
  SortableHeader,
} from "@/components/resource-table";
import { RowsPerPageSelect } from "@/components/rows-per-page-select";
import { SearchInput } from "@/components/search-input";
import { UserCombobox } from "@/components/user-combobox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell } from "@/components/ui/table";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import { useAssetCompanies, useAssets } from "@/lib/api/hooks/use-assets";
import { useAssetsOnTopology } from "@/lib/api/hooks/use-infra-nodes";
import { useUser } from "@/lib/api/hooks/use-users";
import {
  useBatchDeleteAssets,
  useBatchRestoreAssets,
  useBatchSetAssetStatus,
  useDeleteAsset,
  useRestoreAsset,
  useUpdateAsset,
} from "@/lib/api/hooks/use-asset-mutations";
import { useReleaseAssignment } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { useLocations } from "@/lib/api/hooks/use-locations";
import {
  type BatchVerb,
  notifyBatchResult,
} from "@/lib/api/notify-batch-result";
import { notifyError } from "@/lib/api/notify-error";
import type { EntityKey } from "@/lib/entity-key";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { AssetRowActions } from "./asset-row-actions";
import {
  AssetStatusBadge,
  useAssetStatusLabel,
} from "./asset-status-badge";
import { AssignUserDialog } from "./assign-user-dialog";
import { StackedOwnerAvatars } from "./stacked-owner-avatars";

type OwnershipFilter = "ALL" | "HAS" | "NONE";

/**
 * Filter param defaults for the URL list-state. `status`/`category`/`location` map to the server's
 * `status`/`categoryId`/`locationId` params; `owner` maps to the server's `assignedToUserId` (a
 * User uuid, "" = unset); `ownership` (Has/None) maps to the server's `ownership` param (#824).
 * `archived` ("ALL" | "only") drives the ADMIN-only `deleted=only` view via the URL.
 */
const FILTER_DEFAULTS = {
  status: "ALL",
  category: "ALL",
  location: "ALL",
  // Grouping filter (ADR-0076): "ALL" = no filter, otherwise an exact company value (server-side).
  company: "ALL",
  owner: "",
  ownership: "ALL",
  archived: "ALL",
} as const;

/** Maps each ownership filter to its label key under `assets.list.ownership`. */
const OWNERSHIP_LABEL_KEY: Record<OwnershipFilter, "any" | "has" | "none"> = {
  ALL: "any",
  HAS: "has",
  NONE: "none",
};

/**
 * The Assets-table columns an operator can show/hide via the column picker (#695). The `name` identity
 * column (the row's canonical link) and the row `actions` column are always rendered and intentionally
 * absent here. Keys match the `ResourceColumn` keys and the per-key body-cell map below, so the header
 * and body never drift, and the ARRAY ORDER is the canonical left-to-right table order (persistence
 * re-emits selections in this order). Ported from the Users picker and scoped to this page by CTO
 * decision (the shared `ResourceTable` stays untouched).
 */
const HIDEABLE_COLUMNS = [
  "assetTag",
  "model",
  "category",
  "location",
  "company",
  "status",
  "owners",
  "updated",
] as const;
type HideableColumn = (typeof HIDEABLE_COLUMNS)[number];

/**
 * Column-picker grouping — purely presentational structure for the dropdown so the list reads as
 * labelled sections. The flattened union of `keys` MUST equal `HIDEABLE_COLUMNS` (every hideable
 * column appears in exactly one group); it drives only the menu, never visibility.
 */
const COLUMN_GROUPS: { id: string; keys: readonly HideableColumn[] }[] = [
  { id: "details", keys: ["assetTag", "model", "category", "location", "company"] },
  { id: "status", keys: ["status", "owners"] },
  { id: "activity", keys: ["updated"] },
];

/** localStorage key persisting the visible hideable-column set (per browser). */
const COLUMNS_STORAGE_KEY = "lazyit:assets:columns";

/** Stable empty placeholder for the loading skeleton's mobile children slot. */
const LOADING_MOBILE_CHILDREN = <></>;


/**
 * The columns shown by default — the picker subtracts from (and adds back to) this set. Every hideable
 * column is on out of the box, so the table is unchanged for operators who never open the picker; the
 * picker just lets them turn columns off.
 */
const DEFAULT_VISIBLE_COLUMNS: HideableColumn[] = [...HIDEABLE_COLUMNS];

export function AssetsListView() {
  const router = useRouter();
  const t = useTranslations("assets.list");
  const { date } = useFormatters();
  const tEmpty = useTranslations("assets.empty");
  const tc = useTranslations("common");
  const tShared = useTranslations("shared");
  const statusLabel = useAssetStatusLabel();
  // `isAdmin` still gates the archived (`deleted=only`) slice: the API's `assertCanListDeleted` keeps
  // that view ADMIN-only (it was NOT migrated to a permission), so a MEMBER with asset:delete still
  // can't list archived rows. Write/delete affordances use the fine-grained permissions.
  const { isAdmin } = usePermissions();
  const canWrite = useCan("asset:write");
  const canDelete = useCan("asset:delete");
  // Which assets back a topology node — drives the small "On topology" glyph per row (issue #765).
  // Gated on infra:read so a viewer without topology access never fires the node-list fetch.
  const onTopology = useAssetsOnTopology(useCan("infra:read"));
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
    setLimit,
    setOffset,
    clearFilters,
    filtersActive,
  } = useListParams({
    filters: FILTER_DEFAULTS,
    defaultSort: "updatedAt",
    defaultDir: "desc",
  });

  const statusFilter = filters.status as AssetStatus | "ALL";
  const categoryFilter = filters.category;
  const locationFilter = filters.location;
  const companyFilter = filters.company; // "ALL" = unset; otherwise an exact company value.
  const ownerFilter = filters.owner; // "" = unset; otherwise a User uuid (server-side filter)
  const ownershipFilter = filters.ownership as OwnershipFilter;
  // Resolve the owner-filter user's name for its chip, even when not on the current search page.
  const { data: ownerUser } = useUser(ownerFilter || undefined);
  // The archived view is ADMIN-only; a non-admin can never set it (toggle hidden) and we never send
  // the param for them, so the API stays on the active-only list.
  const archived = isAdmin && filters.archived === "only";

  // Forward server-supported params; `ownership` (Has/None) is now a server filter too (#824), so it
  // scopes the whole result set instead of just the current page.
  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useAssets({
      q: q || undefined,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      categoryId: categoryFilter === "ALL" ? undefined : categoryFilter,
      locationId: locationFilter === "ALL" ? undefined : locationFilter,
      company: companyFilter === "ALL" ? undefined : companyFilter,
      assignedToUserId: ownerFilter || undefined,
      ownership: ownershipFilter === "ALL" ? undefined : ownershipFilter,
      sort,
      dir: sort ? dir : undefined,
      limit,
      offset,
      deleted: archived ? "only" : undefined,
    });
  const { data: categories } = useAssetCategories();
  const { data: locations } = useLocations();
  const { data: companies } = useAssetCompanies();
  const deleteAsset = useDeleteAsset();
  const restoreAsset = useRestoreAsset();
  const updateAsset = useUpdateAsset();
  const releaseAssignment = useReleaseAssignment();
  const batchDelete = useBatchDeleteAssets();
  const batchRestore = useBatchRestoreAssets();
  const batchStatus = useBatchSetAssetStatus();

  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  );
  // The asset the Assign dialog targets (null = closed). Its current owners are excluded from the
  // picker. Reuses the same dialog as the detail page — verbatim.
  const [assigning, setAssigning] = useState<AssetListItem | null>(null);
  // The asset whose single active owner is being unassigned, pending confirm (null = closed). The
  // list row already carries `activeAssignments[0].id`, so releasing needs no extra fetch.
  const [unassigning, setUnassigning] = useState<AssetListItem | null>(null);

  // Per-browser column-picker state (#695, ported from Users). `mounted` gates the persisted set so
  // SSR/first paint always renders the full `DEFAULT_VISIBLE_COLUMNS` (the server snapshot) — no
  // hydration flash.
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

  // The page is already scoped server-side (status/category/location/owner/ownership/#824), so the
  // rendered rows are the page items verbatim — no client-side post-filter over the window.
  const rows = useMemo(() => page?.items ?? [], [page?.items]);

  // Multi-select over the currently visible rows — the API batch endpoints all require asset:delete
  // (bulk delete/restore/status are lifecycle ops), so gate the selection column on canDelete.
  const visibleIds = useMemo(() => rows.map((asset) => asset.id), [rows]);
  const selection = useRowSelection(visibleIds);
  const selectable = canDelete;

  /** Run a batch mutation, toast the per-id outcome, and clear the selection. */
  async function runBatch(
    run: () => Promise<BatchResult>,
    labels: { entityKey: EntityKey; verb: BatchVerb },
    fallback: string,
  ) {
    try {
      const result = await run();
      notifyBatchResult(result, { ...labels, t: tShared });
      selection.clear();
    } catch (err) {
      notifyError(err, fallback);
    }
  }

  function handleRestoreRow(id: string, name: string) {
    restoreAsset.mutate(id, {
      onSuccess: () => toast.success(t("restoredToast", { name })),
      onError: (err) => notifyError(err, t("restoreError")),
    });
  }

  /** Change one asset's status from the row kebab (reversible — no confirm, matching the batch flow). */
  function handleChangeStatus(asset: AssetListItem, status: AssetStatus) {
    if (status === asset.status) return;
    updateAsset.mutate(
      { id: asset.id, data: { status } },
      {
        onSuccess: () =>
          toast.success(
            t("statusChangedToast", { status: statusLabel(status) }),
          ),
        onError: (err) => notifyError(err, t("statusChangeError")),
      },
    );
  }

  /** Release the asset's single active owner (the row carries its assignment id — no extra fetch). */
  function handleConfirmUnassign() {
    const assignmentId = unassigning?.activeAssignments[0]?.id;
    if (!assignmentId) return;
    releaseAssignment.mutate(
      { id: assignmentId },
      {
        onSuccess: () => {
          toast.success(t("unassignedToast"));
          setUnassigning(null);
        },
        onError: (err) => notifyError(err, t("unassignError")),
      },
    );
  }

  /**
   * The one color-coded quick action per row (active view, `asset:write` only): a blue tonal
   * **Assign** when the asset has no live owner, an amber tonal **Unassign** when it does. Assign
   * reuses the detail page's {@link AssignUserDialog}; Unassign goes through a confirm. Returns null
   * when the operator can't write, so the column stays empty for them.
   */
  function rowQuickAction(asset: AssetListItem) {
    if (!canWrite) return null;
    const owned = asset.activeAssignments.length > 0;
    return owned ? (
      <Button
        variant="warning"
        size="sm"
        onClick={() => setUnassigning(asset)}
      >
        <UserMinusIcon />
        {t("unassign")}
      </Button>
    ) : (
      <Button variant="info" size="sm" onClick={() => setAssigning(asset)}>
        <UserPlusIcon />
        {t("assign")}
      </Button>
    );
  }

  /** The Assets-local row kebab for the active view, wired to this row's permissions + state. */
  function rowKebab(asset: AssetListItem) {
    if (!canWrite && !canDelete) return null;
    const owned = asset.activeAssignments.length > 0;
    return (
      <AssetRowActions
        assetId={asset.id}
        currentStatus={asset.status}
        hasOwner={owned}
        onEdit={
          canWrite ? () => router.push(`/assets/${asset.id}/edit`) : undefined
        }
        onClone={
          canWrite ? () => router.push(`/assets/${asset.id}/clone`) : undefined
        }
        onAssign={canWrite ? () => setAssigning(asset) : undefined}
        onUnassign={canWrite ? () => setUnassigning(asset) : undefined}
        onChangeStatus={
          canWrite
            ? (status) => handleChangeStatus(asset, status)
            : undefined
        }
        onDelete={
          canDelete
            ? () => setDeleting({ id: asset.id, name: asset.name })
            : undefined
        }
      />
    );
  }

  const columns = useMemo<ResourceColumn[]>(() => {
    // Entries are `ResourceColumn | false`; a hideable column collapses to `false` when toggled off
    // and is dropped below, so the rendered set always matches the persisted visible-column set.
    const defs: (ResourceColumn | false)[] = [
      {
        key: "name",
        header: (
          <SortableHeader
            label={t("columns.name")}
            active={sort === "name"}
            direction={dir}
            onToggle={() => toggleSort("name")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-32" />,
      },
      isColumnVisible("assetTag") && {
        key: "assetTag",
        header: (
          <SortableHeader
            label={t("columns.assetTag")}
            active={sort === "assetTag"}
            direction={dir}
            onToggle={() => toggleSort("assetTag")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      isColumnVisible("model") && {
        key: "model",
        header: t("columns.model"),
        skeleton: <Skeleton className="h-4 w-28" />,
      },
      isColumnVisible("category") && {
        key: "category",
        header: t("columns.category"),
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      isColumnVisible("location") && {
        key: "location",
        header: t("columns.location"),
        skeleton: <Skeleton className="h-4 w-24" />,
      },
      isColumnVisible("company") && {
        key: "company",
        header: t("columns.company"),
        skeleton: <Skeleton className="h-4 w-24" />,
      },
      isColumnVisible("status") && {
        key: "status",
        header: (
          <SortableHeader
            label={t("columns.status")}
            active={sort === "status"}
            direction={dir}
            onToggle={() => toggleSort("status")}
          />
        ),
        skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
      },
      isColumnVisible("owners") && {
        key: "owners",
        header: t("columns.owners"),
        skeleton: <Skeleton className="size-6 rounded-full" />,
      },
      isColumnVisible("updated") && {
        key: "updated",
        header: (
          <SortableHeader
            label={t("columns.updated")}
            active={sort === "updatedAt"}
            direction={dir}
            onToggle={() => toggleSort("updatedAt")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "actions",
        header: t("columns.actions"),
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

  // Count of the filters living INSIDE the Filters popover (search + status stay inline), for its
  // trigger badge. The active-filter chip row below remains the full recovery path.
  const popoverFilterCount =
    (categoryFilter !== "ALL" ? 1 : 0) +
    (locationFilter !== "ALL" ? 1 : 0) +
    (companyFilter !== "ALL" ? 1 : 0) +
    (ownerFilter ? 1 : 0) +
    (ownershipFilter !== "ALL" ? 1 : 0);

  const chips = [
    ...(q
      ? [
          {
            key: "q",
            label: t("chips.search", { query: q }),
            onClear: () => setQ(""),
          },
        ]
      : []),
    ...(statusFilter !== "ALL"
      ? [
          {
            key: "status",
            label: t("chips.status", { value: statusLabel(statusFilter) }),
            onClear: () => setFilter("status", FILTER_DEFAULTS.status),
          },
        ]
      : []),
    ...(categoryFilter !== "ALL"
      ? [
          {
            key: "category",
            label: t("chips.category", {
              value:
                categories?.find((c) => c.id === categoryFilter)?.name ?? "—",
            }),
            onClear: () => setFilter("category", FILTER_DEFAULTS.category),
          },
        ]
      : []),
    ...(locationFilter !== "ALL"
      ? [
          {
            key: "location",
            label: t("chips.location", {
              value:
                locations?.find((l) => l.id === locationFilter)?.name ?? "—",
            }),
            onClear: () => setFilter("location", FILTER_DEFAULTS.location),
          },
        ]
      : []),
    ...(companyFilter !== "ALL"
      ? [
          {
            key: "company",
            label: t("chips.company", { value: companyFilter }),
            onClear: () => setFilter("company", FILTER_DEFAULTS.company),
          },
        ]
      : []),
    ...(ownerFilter
      ? [
          {
            key: "owner",
            label: t("chips.owner", {
              value: ownerUser
                ? `${ownerUser.firstName} ${ownerUser.lastName}`
                : "…",
            }),
            onClear: () => setFilter("owner", FILTER_DEFAULTS.owner),
          },
        ]
      : []),
    ...(ownershipFilter !== "ALL"
      ? [
          {
            key: "ownership",
            label: t("chips.owners", {
              value: t(`ownership.${OWNERSHIP_LABEL_KEY[ownershipFilter]}`),
            }),
            onClear: () => setFilter("ownership", FILTER_DEFAULTS.ownership),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        pillar="inventory"
        icon={ServerStackIcon}
        subtitle={t("subtitle")}
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
            {canWrite ? (
              <Button asChild>
                <Link href="/assets/new">
                  <PlusIcon />
                  {t("newAsset")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      {isLoading ? (
        <ResourceTable columns={columns} isLoading mobileChildren={LOADING_MOBILE_CHILDREN} />
      ) : isError ? (
        <ErrorState
          title={t("errorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={ServerStackIcon}
          pillar="inventory"
          title={tEmpty("title")}
          description={tEmpty("description")}
          action={
            canWrite
              ? { label: tEmpty("action"), href: "/assets/new" }
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
              label={t("searchLabel")}
              placeholder={t("searchPlaceholder")}
              className="lg:max-w-xs lg:flex-1"
            />
            <Select
              value={statusFilter}
              onValueChange={(value) => setFilter("status", value)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("filters.allStatuses")}</SelectItem>
                {AssetStatusSchema.options.map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabel(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="justify-start lg:w-auto">
                  <FunnelIcon />
                  {t("filters.moreFilters")}
                  {popoverFilterCount > 0 ? (
                    <Badge
                      variant="secondary"
                      className="ml-1 size-5 justify-center rounded-full p-0 tabular-nums"
                    >
                      {popoverFilterCount}
                    </Badge>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 space-y-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="assets-filter-category"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("columns.category")}
                  </label>
                  <Select
                    value={categoryFilter}
                    onValueChange={(value) => setFilter("category", value)}
                  >
                    <SelectTrigger id="assets-filter-category" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">
                        {t("filters.allCategories")}
                      </SelectItem>
                      {(categories ?? []).map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="assets-filter-location"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("columns.location")}
                  </label>
                  <Select
                    value={locationFilter}
                    onValueChange={(value) => setFilter("location", value)}
                  >
                    <SelectTrigger id="assets-filter-location" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">
                        {t("filters.allLocations")}
                      </SelectItem>
                      {(locations ?? []).map((location) => (
                        <SelectItem key={location.id} value={location.id}>
                          {location.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="assets-filter-company"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("columns.company")}
                  </label>
                  <Select
                    value={companyFilter}
                    onValueChange={(value) => setFilter("company", value)}
                  >
                    <SelectTrigger id="assets-filter-company" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">
                        {t("filters.allCompanies")}
                      </SelectItem>
                      {(companies ?? []).map((company) => (
                        <SelectItem key={company} value={company}>
                          {company}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="assets-filter-owner"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("filters.ownerLabel")}
                  </label>
                  <UserCombobox
                    id="assets-filter-owner"
                    value={ownerFilter || undefined}
                    onValueChange={(value) => setFilter("owner", value)}
                    placeholder={t("filters.ownerPlaceholder")}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="assets-filter-ownership"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("filters.ownershipLabel")}
                  </label>
                  <Select
                    value={ownershipFilter}
                    onValueChange={(value) => setFilter("ownership", value)}
                  >
                    <SelectTrigger
                      id="assets-filter-ownership"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">
                        {t("filters.anyOwnership")}
                      </SelectItem>
                      <SelectItem value="HAS">
                        {t("filters.hasOwners")}
                      </SelectItem>
                      <SelectItem value="NONE">
                        {t("filters.noOwners")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </PopoverContent>
            </Popover>
            <RowsPerPageSelect
              value={limit}
              onChange={setLimit}
              className="lg:ml-auto lg:w-44"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("columnPicker.label")}
                  title={t("columnPicker.label")}
                >
                  <ViewColumnsIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel>{t("columnPicker.label")}</DropdownMenuLabel>
                {COLUMN_GROUPS.map((group) => (
                  <div key={group.id}>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                      {t(`columnPicker.groups.${group.id}`)}
                    </DropdownMenuLabel>
                    {group.keys.map((key) => (
                      <DropdownMenuCheckboxItem
                        key={key}
                        checked={isColumnVisible(key)}
                        // Keep the menu open so several columns can be toggled in one pass.
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) => toggleColumn(key, checked)}
                      >
                        {t(`columnPicker.columns.${key}`)}
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
              archived ? t("filteredEmptyArchived") : t("filteredEmpty")
            }
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            selection={
              selectable
                ? {
                    enabled: true,
                    allSelected: selection.allSelected,
                    someSelected: selection.someSelected,
                    onToggleAll: selection.toggleAll,
                    selectAllLabel: t("selectAllLabel"),
                  }
                : undefined
            }
            mobileChildren={rows.map((asset) => (
              <ResourceCard
                key={asset.id}
                href={`/assets/${asset.id}`}
                title={
                  <span className="inline-flex items-center gap-1.5">
                    {asset.name}
                    {onTopology.has(asset.id) ? (
                      <ShareIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label={t("onTopology")}
                      />
                    ) : null}
                  </span>
                }
                badge={<AssetStatusBadge status={asset.status} />}
                selectable={selectable}
                selected={selection.isSelected(asset.id)}
                onSelectedChange={(on) => selection.setSelected(asset.id, on)}
                selectLabel={t("selectRowLabel", { name: asset.name })}
                meta={
                  <>
                    <ResourceCardMeta label={t("columns.assetTag")}>
                      <span className="font-mono tabular-nums">
                        {asset.assetTag ?? "—"}
                      </span>
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.model")}>
                      {asset.model?.name ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.category")}>
                      {asset.model?.category ? (
                        <Badge variant="outline">
                          {asset.model.category.name}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.location")}>
                      {asset.location?.name ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.company")}>
                      {asset.company ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.owners")}>
                      <StackedOwnerAvatars
                        assignments={asset.activeAssignments}
                      />
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.updated")}>
                      <span className="font-mono tabular-nums">
                        {date(asset.updatedAt)}
                      </span>
                    </ResourceCardMeta>
                  </>
                }
                actions={
                  archived ? (
                    canDelete ? (
                      <RestoreRowAction
                        onRestore={() =>
                          handleRestoreRow(asset.id, asset.name)
                        }
                        disabled={restoreAsset.isPending}
                      />
                    ) : undefined
                  ) : canWrite || canDelete ? (
                    <>
                      {rowQuickAction(asset)}
                      {rowKebab(asset)}
                    </>
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((asset) => {
              // Per-key body cells, keyed to the same column keys as the `columns` memo above. We
              // render by iterating `columns`, so a hidden column drops from the header AND the body
              // in lockstep — they can never drift. Structural keys (name/actions) are always present
              // here; the hideable ones simply won't be looked up when their column is off.
              const cells: Record<string, ReactNode> = {
                name: (
                  <TableCell key="name" className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <Link
                        href={`/assets/${asset.id}`}
                        className="hover:underline"
                      >
                        {asset.name}
                      </Link>
                      {onTopology.has(asset.id) ? (
                        <ShareIcon
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-label={t("onTopology")}
                        />
                      ) : null}
                    </span>
                  </TableCell>
                ),
                assetTag: (
                  <TableCell
                    key="assetTag"
                    className="font-mono text-muted-foreground tabular-nums"
                  >
                    {asset.assetTag ?? "—"}
                  </TableCell>
                ),
                model: (
                  <TableCell key="model" className="text-muted-foreground">
                    {asset.model?.name ?? "—"}
                  </TableCell>
                ),
                category: (
                  <TableCell key="category">
                    {asset.model?.category ? (
                      <Badge variant="outline">
                        {asset.model.category.name}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                ),
                location: (
                  <TableCell key="location" className="text-muted-foreground">
                    {asset.location?.name ?? "—"}
                  </TableCell>
                ),
                company: (
                  <TableCell key="company" className="text-muted-foreground">
                    {asset.company ?? "—"}
                  </TableCell>
                ),
                status: (
                  <TableCell key="status">
                    <AssetStatusBadge status={asset.status} />
                  </TableCell>
                ),
                owners: (
                  <TableCell key="owners">
                    <StackedOwnerAvatars
                      assignments={asset.activeAssignments}
                    />
                  </TableCell>
                ),
                updated: (
                  <TableCell
                    key="updated"
                    className="font-mono text-muted-foreground tabular-nums"
                  >
                    {date(asset.updatedAt)}
                  </TableCell>
                ),
                actions: (
                  <TableCell key="actions" className="text-right">
                    {archived ? (
                      canDelete ? (
                        <div className="flex justify-end">
                          <RestoreRowAction
                            onRestore={() =>
                              handleRestoreRow(asset.id, asset.name)
                            }
                            disabled={restoreAsset.isPending}
                          />
                        </div>
                      ) : null
                    ) : canWrite || canDelete ? (
                      <div className="flex items-center justify-end gap-1">
                        {/* The colored quick action stays visible (a primary affordance); only the
                            kebab fades in on row hover/focus to keep dense lists calm. */}
                        {rowQuickAction(asset)}
                        <span className={rowActionsReveal}>
                          {rowKebab(asset)}
                        </span>
                      </div>
                    ) : null}
                  </TableCell>
                ),
              };
              return (
                <LinkableRow
                  key={asset.id}
                  href={`/assets/${asset.id}`}
                  data-state={
                    selectable && selection.isSelected(asset.id)
                      ? "selected"
                      : undefined
                  }
                >
                  {selectable ? (
                    <SelectCell
                      checked={selection.isSelected(asset.id)}
                      onCheckedChange={(on) =>
                        selection.setSelected(asset.id, on)
                      }
                      label={t("selectRowLabel", { name: asset.name })}
                    />
                  ) : null}
                  {columns.map((column) => cells[column.key])}
                </LinkableRow>
              );
            })}
          </ResourceTable>

          <BatchActionBar
            count={selection.count}
            onClear={selection.clear}
            entityKey="asset"
          >
            {archived ? (
              <Button
                size="sm"
                onClick={() =>
                  runBatch(
                    () => batchRestore.mutateAsync(selection.selectedIds),
                    { entityKey: "asset", verb: "restored" },
                    t("batchRestoreError"),
                  )
                }
                disabled={batchRestore.isPending}
              >
                <ArrowUturnLeftIcon />
                {t("restore")}
              </Button>
            ) : (
              <>
                <Select
                  onValueChange={(value) =>
                    runBatch(
                      () =>
                        batchStatus.mutateAsync({
                          ids: selection.selectedIds,
                          status: value as AssetStatus,
                        }),
                      { entityKey: "asset", verb: "updated" },
                      t("batchStatusError"),
                    )
                  }
                >
                  <SelectTrigger size="sm" className="w-40">
                    <SelectValue placeholder={t("setStatusPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {AssetStatusSchema.options.map((status) => (
                      <SelectItem key={status} value={status}>
                        {statusLabel(status)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    runBatch(
                      () => batchDelete.mutateAsync(selection.selectedIds),
                      { entityKey: "asset", verb: "deleted" },
                      t("batchDeleteError"),
                    )
                  }
                  disabled={batchDelete.isPending}
                >
                  <TrashIcon />
                  {tc("delete")}
                </Button>
              </>
            )}
          </BatchActionBar>

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
          entityKey="asset"
          name={deleting.name}
          onConfirm={() => deleteAsset.mutateAsync(deleting.id)}
        />
      ) : null}

      {/* Assign — the same dialog the detail page uses, verbatim. Excludes current owners so a
          person can't be double-assigned to the same asset. */}
      {assigning ? (
        <AssignUserDialog
          open
          onOpenChange={(open) => {
            if (!open) setAssigning(null);
          }}
          assetId={assigning.id}
          excludeUserIds={assigning.activeAssignments.map((a) => a.userId)}
        />
      ) : null}

      {/* Unassign — a confirm before releasing the active owner (prevents accidental un-assignments).
          The row already carries the assignment id, so no extra fetch is needed. */}
      {unassigning ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !releaseAssignment.isPending) setUnassigning(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("unassignConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("unassignConfirmDescription", { name: unassigning.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={releaseAssignment.isPending}>
                {tc("cancel")}
              </AlertDialogCancel>
              {/* Plain warning button (not AlertDialogAction) so we own the spinner and only close
                  on success — matching the DeleteConfirmDialog pattern. */}
              <Button
                variant="warning"
                onClick={handleConfirmUnassign}
                disabled={releaseAssignment.isPending}
              >
                {releaseAssignment.isPending && (
                  <ArrowPathIcon className="animate-spin" />
                )}
                {t("unassign")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
