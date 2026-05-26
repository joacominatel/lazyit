"use client";

import {
  MagnifyingGlassIcon,
  MapPinIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  type Location,
  type LocationType,
  LocationTypeSchema,
} from "@lazyit/shared";
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
import { useDeleteLocation } from "@/lib/api/hooks/use-location-mutations";
import { useLocations } from "@/lib/api/hooks/use-locations";
import { formatDate } from "@/lib/utils/format";
import { LocationFormDialog } from "./_components/location-form-dialog";
import {
  formatLocationType,
  LocationTypeBadge,
} from "./_components/location-type-badge";

const COLUMNS: ResourceColumn[] = [
  { key: "name", header: "Name", skeleton: <Skeleton className="h-4 w-40" /> },
  {
    key: "type",
    header: "Type",
    skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
  },
  { key: "floor", header: "Floor", skeleton: <Skeleton className="h-4 w-10" /> },
  {
    key: "address",
    header: "Address",
    skeleton: <Skeleton className="h-4 w-48" />,
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

export default function LocationsPage() {
  const { data: locations, isLoading, isError, error, refetch } =
    useLocations();
  const deleteLocation = useDeleteLocation();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<LocationType | "ALL">("ALL");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Location | undefined>(undefined);
  const [deleting, setDeleting] = useState<Location | undefined>(undefined);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (locations ?? []).filter((location) => {
      const matchesType = typeFilter === "ALL" || location.type === typeFilter;
      const matchesSearch =
        query === "" || location.name.toLowerCase().includes(query);
      return matchesType && matchesSearch;
    });
  }, [locations, search, typeFilter]);

  const hasData = (locations?.length ?? 0) > 0;

  function openCreate() {
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(location: Location) {
    setEditing(location);
    setFormOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
          <p className="text-sm text-muted-foreground">
            Where your assets physically live.
          </p>
        </div>
        <Button onClick={openCreate}>
          <PlusIcon />
          New location
        </Button>
      </div>

      {isLoading ? (
        <ResourceTable columns={COLUMNS} isLoading />
      ) : isError ? (
        <ErrorState
          title="Could not load locations"
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <EmptyState
          icon={MapPinIcon}
          title="No locations yet"
          description="Add your first location to start tracking where assets live."
          action={
            <Button onClick={openCreate}>
              <PlusIcon />
              Create your first location
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
                placeholder="Search by name…"
                className="pl-8"
              />
            </div>
            <Select
              value={typeFilter}
              onValueChange={(value) =>
                setTypeFilter(value as LocationType | "ALL")
              }
            >
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All types</SelectItem>
                {LocationTypeSchema.options.map((type) => (
                  <SelectItem key={type} value={type}>
                    {formatLocationType(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ResourceTable
            columns={COLUMNS}
            isFilteredEmpty={filtered.length === 0}
            filteredEmptyMessage="No locations match your filters."
          >
            {filtered.map((location) => (
              <TableRow key={location.id}>
                <TableCell className="font-medium">{location.name}</TableCell>
                <TableCell>
                  <LocationTypeBadge type={location.type} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {location.floor ?? "—"}
                </TableCell>
                <TableCell
                  className="max-w-[220px] truncate text-muted-foreground"
                  title={location.address ?? undefined}
                >
                  {location.address ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDate(location.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <RowActions
                    onEdit={() => openEdit(location)}
                    onDelete={() => setDeleting(location)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </ResourceTable>
        </>
      )}

      <LocationFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        location={editing}
      />
      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          entityLabel="location"
          name={deleting.name}
          onConfirm={() => deleteLocation.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
