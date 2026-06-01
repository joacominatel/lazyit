"use client";

import {
  ArrowLeftIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  type ResourceColumn,
  ResourceTable,
} from "@/components/resource-table";
import { useAssets } from "@/lib/api/hooks/use-assets";
import { useDeleteLocation } from "@/lib/api/hooks/use-location-mutations";
import { useLocation } from "@/lib/api/hooks/use-locations";
import { formatDate } from "@/lib/utils/format";
import { AssetStatusBadge } from "../../assets/_components/asset-status-badge";
import { StackedOwnerAvatars } from "../../assets/_components/stacked-owner-avatars";
import { LocationFormDialog } from "../_components/location-form-dialog";
import { LocationTypeBadge } from "../_components/location-type-badge";

/**
 * Location detail — the place's own facts plus the asset-centric "assets here" view: the inventory
 * physically located at it ({@link useAssets} filtered by `locationId`). Mirrors the asset detail
 * page's panel/owner-avatar treatment so the two reads cross-link cleanly.
 */
export default function LocationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const { data: location, isLoading, isError } = useLocation(id);
  // Assets at this location (one page up to the max — a single physical site won't exceed it).
  const { data: assetsPage, isLoading: assetsLoading } = useAssets({
    locationId: id,
    limit: MAX_PAGE_LIMIT,
  });
  const deleteLocation = useDeleteLocation();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !location) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium">Location not found</p>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Button variant="outline" asChild>
          <Link href="/locations">
            <ArrowLeftIcon />
            Back to Locations
          </Link>
        </Button>
      </div>
    );
  }

  const assets = assetsPage?.items ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/locations">
              <ArrowLeftIcon />
              Locations
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {location.name}
            </h1>
            <LocationTypeBadge type={location.type} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <PencilSquareIcon />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete location"
            onClick={() => setDeleteOpen(true)}
          >
            <TrashIcon />
          </Button>
        </div>
      </div>

      <Panel title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <Detail label="Type">
            <LocationTypeBadge type={location.type} />
          </Detail>
          <Detail label="Floor">{location.floor ?? "—"}</Detail>
          <Detail label="Address">{location.address ?? "—"}</Detail>
          <Detail label="Last updated">{formatDate(location.updatedAt)}</Detail>
        </dl>
        {location.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
            <dd className="text-sm whitespace-pre-wrap">{location.notes}</dd>
          </div>
        )}
      </Panel>

      <Panel
        title={`Assets here${assets.length > 0 ? ` (${assets.length})` : ""}`}
        action={
          <Button size="sm" variant="outline" asChild>
            <Link href="/assets/new">
              <PlusIcon />
              New asset
            </Link>
          </Button>
        }
      >
        {assetsLoading ? (
          <ResourceTable columns={ASSET_COLUMNS} isLoading />
        ) : assets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No assets are located here yet.
          </p>
        ) : (
          <ResourceTable columns={ASSET_COLUMNS}>
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
      </Panel>

      <LocationFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        location={location}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityLabel="location"
        name={location.name}
        onConfirm={() => deleteLocation.mutateAsync(location.id)}
        onDeleted={() => router.push("/locations")}
      />
    </div>
  );
}

const ASSET_COLUMNS: ResourceColumn[] = [
  { key: "name", header: "Name", skeleton: <Skeleton className="h-4 w-32" /> },
  {
    key: "assetTag",
    header: "Asset tag",
    skeleton: <Skeleton className="h-4 w-20" />,
  },
  {
    key: "category",
    header: "Category",
    skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
  },
  {
    key: "status",
    header: "Status",
    skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
  },
  {
    key: "owners",
    header: "Owners",
    skeleton: <Skeleton className="size-6 rounded-full" />,
  },
];

/** A bordered section with a heading and optional header action. */
function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A label/value pair in the details grid. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
