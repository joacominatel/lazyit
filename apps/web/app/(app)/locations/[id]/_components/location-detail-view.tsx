"use client";

import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  ErrorState,
  type ResourceColumn,
  ResourceTable,
} from "@/components/resource-table";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { useAssets } from "@/lib/api/hooks/use-assets";
import { useDeleteLocation } from "@/lib/api/hooks/use-location-mutations";
import { useLocation } from "@/lib/api/hooks/use-locations";
import { AssetStatusBadge } from "../../../assets/_components/asset-status-badge";
import { StackedOwnerAvatars } from "../../../assets/_components/stacked-owner-avatars";
import { LocationFormDialog } from "../../_components/location-form-dialog";
import { LocationTypeBadge } from "../../_components/location-type-badge";

/**
 * Location detail — the place's own facts plus the asset-centric "assets here" view: the inventory
 * physically located at it ({@link useAssets} filtered by `locationId`). Mirrors the asset detail
 * page's panel/owner-avatar treatment so the two reads cross-link cleanly.
 */
export function LocationDetailView({ id }: { id: string }) {
  const t = useTranslations("locations");
  const tc = useTranslations("common");
  const { date } = useFormatters();
  const router = useRouter();
  // Edit is location:write, Delete is location:delete; the "New asset here" shortcut is an asset
  // create, so it's gated on asset:write (cross-domain affordance).
  const canWrite = useCan("location:write");
  const canDelete = useCan("location:delete");
  const canCreateAsset = useCan("asset:write");

  const { data: location, isLoading, isError, error, refetch } =
    useLocation(id);
  // Assets at this location (one page up to the max — a single physical site won't exceed it).
  const { data: assetsPage, isLoading: assetsLoading } = useAssets({
    locationId: id,
    limit: MAX_PAGE_LIMIT,
  });
  const deleteLocation = useDeleteLocation();

  const assetColumns = useMemo<ResourceColumn[]>(
    () => [
      {
        key: "name",
        header: t("detail.assetColumns.name"),
        skeleton: <Skeleton className="h-4 w-32" />,
      },
      {
        key: "assetTag",
        header: t("detail.assetColumns.assetTag"),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "category",
        header: t("detail.assetColumns.category"),
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        key: "status",
        header: t("detail.assetColumns.status"),
        skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
      },
      {
        key: "owners",
        header: t("detail.assetColumns.owners"),
        skeleton: <Skeleton className="size-6 rounded-full" />,
      },
    ],
    [t],
  );

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("detail.breadcrumb"), href: "/locations" },
          { label: location?.name ?? "" },
        ]}
      />
    ),
    [t, location?.name],
  );

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={2} />
      </div>
    );
  }

  if (isError || !location) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const assets = assetsPage?.items ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={location.name}
        badge={<LocationTypeBadge type={location.type} />}
        actions={
          canWrite || canDelete ? (
            <>
              {canWrite ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditOpen(true)}
                >
                  <PencilSquareIcon />
                  {tc("edit")}
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("detail.deleteAria")}
                  onClick={() => setDeleteOpen(true)}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      <DetailPanel title={t("detail.detailsTitle")}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label={t("detail.fields.type")}>
            <LocationTypeBadge type={location.type} />
          </DetailField>
          <DetailField label={t("detail.fields.floor")}>
            {location.floor ?? "—"}
          </DetailField>
          <DetailField label={t("detail.fields.address")}>
            {location.address ?? "—"}
          </DetailField>
          <DetailField label={t("detail.fields.lastUpdated")} mono>
            {date(location.updatedAt)}
          </DetailField>
        </dl>
        {location.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">
              {t("detail.fields.notes")}
            </dt>
            <dd className="text-sm whitespace-pre-wrap">{location.notes}</dd>
          </div>
        )}
      </DetailPanel>

      <DetailPanel
        title={
          assets.length > 0
            ? t("detail.assetsTitleCount", { count: assets.length })
            : t("detail.assetsTitle")
        }
        actions={
          canCreateAsset ? (
            <Button size="sm" variant="outline" asChild>
              <Link href="/assets/new">
                <PlusIcon />
                {t("detail.newAsset")}
              </Link>
            </Button>
          ) : undefined
        }
      >
        {assetsLoading ? (
          <ResourceTable columns={assetColumns} isLoading />
        ) : assets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("detail.noAssets")}
          </p>
        ) : (
          <ResourceTable columns={assetColumns}>
            {assets.map((asset) => (
              <TableRow key={asset.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/assets/${asset.id}`}
                    className="hover:underline"
                  >
                    {asset.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {asset.assetTag ?? "—"}
                </TableCell>
                <TableCell>
                  {asset.model?.category ? (
                    <Badge variant="outline">{asset.model.category.name}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <AssetStatusBadge status={asset.status} />
                </TableCell>
                <TableCell>
                  <StackedOwnerAvatars assignments={asset.activeAssignments} />
                </TableCell>
              </TableRow>
            ))}
          </ResourceTable>
        )}
      </DetailPanel>

      <LocationFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        location={location}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityKey="location"
        name={location.name}
        onConfirm={() => deleteLocation.mutateAsync(location.id)}
        onDeleted={() => router.push("/locations")}
      />
    </div>
  );
}
