"use client";

import {
  ArrowPathIcon,
  EllipsisVerticalIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  type Location,
  type LocationType,
  LocationTypeSchema,
} from "@lazyit/shared";
import { useMemo, useState } from "react";
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
import { useLocations } from "@/lib/api/hooks/use-locations";
import { DeleteLocationDialog } from "./_components/delete-location-dialog";
import { LocationFormDialog } from "./_components/location-form-dialog";
import {
  formatLocationType,
  LocationTypeBadge,
} from "./_components/location-type-badge";

export default function LocationsPage() {
  const { data: locations, isLoading, isError, refetch } = useLocations();

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

          <TableShell>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="h-24 text-center text-muted-foreground"
                >
                  No locations match your filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((location) => (
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
              ))
            )}
          </TableShell>
        </>
      )}

      <LocationFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        location={editing}
      />
      {deleting ? (
        <DeleteLocationDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          location={deleting}
        />
      ) : null}
    </div>
  );
}

const COLUMN_COUNT = 6;
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e"] as const;

/** Bordered container + shared header for the locations table. */
function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Floor</TableHead>
            <TableHead>Address</TableHead>
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
            <Skeleton className="h-4 w-40" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-16 rounded-full" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-10" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-48" />
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
        <MapPinIcon className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No locations yet</p>
        <p className="text-sm text-muted-foreground">
          Add your first location to start tracking where assets live.
        </p>
      </div>
      <Button onClick={onCreate}>
        <PlusIcon />
        Create your first location
      </Button>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <p className="text-sm font-medium">Could not load locations</p>
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
