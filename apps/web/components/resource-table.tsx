"use client";

import {
  ArrowPathIcon,
  EllipsisVerticalIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType, ReactNode } from "react";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api/client";

/** A column definition for {@link ResourceTable} — header + loading skeleton. */
export interface ResourceColumn {
  /** Stable key for React lists. */
  key: string;
  /** Header label. Rendered visually unless {@link srOnlyHeader} is set. */
  header: ReactNode;
  /** Render the header for screen readers only (e.g. avatar/actions columns). */
  srOnlyHeader?: boolean;
  /** Extra classes on the `<th>` (e.g. "w-12", "w-12 text-right"). */
  headClassName?: string;
  /** Skeleton cell content during loading. Defaults to a short text line. */
  skeleton?: ReactNode;
}

const DEFAULT_SKELETON_ROWS = 5;
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

interface ResourceTableProps {
  columns: ResourceColumn[];
  /** Show skeleton rows instead of content (initial load). */
  isLoading?: boolean;
  /** Number of skeleton rows to show while loading (max 8). */
  skeletonRows?: number;
  /** Data loaded but the active filters matched nothing. */
  isFilteredEmpty?: boolean;
  /** Message for the filtered-empty row. */
  filteredEmptyMessage?: string;
  /** The table rows, rendered when not loading / filtered-empty. */
  children?: ReactNode;
}

/**
 * Bordered table shell with a header derived from `columns`, plus the two
 * in-table states (loading skeletons and filtered-empty). Pages own the rows,
 * the filter bar and the no-data / error branches (via EmptyState/ErrorState).
 * The shared scaffolding behind every resource list — see ADR-0020.
 */
export function ResourceTable({
  columns,
  isLoading = false,
  skeletonRows = DEFAULT_SKELETON_ROWS,
  isFilteredEmpty = false,
  filteredEmptyMessage = "No matching results.",
  children,
}: ResourceTableProps) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.headClassName}>
                {column.srOnlyHeader ? (
                  <span className="sr-only">{column.header}</span>
                ) : (
                  column.header
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            SKELETON_ROW_KEYS.slice(0, skeletonRows).map((rowKey) => (
              <TableRow key={rowKey}>
                {columns.map((column) => (
                  <TableCell key={column.key}>
                    {column.skeleton ?? <Skeleton className="h-4 w-24" />}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : isFilteredEmpty ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-24 text-center text-muted-foreground"
              >
                {filteredEmptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            children
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/** Per-row actions dropdown (Edit / Delete) shared by resource tables. */
export function RowActions({
  onEdit,
  onDelete,
  editLabel = "Edit",
  deleteLabel = "Delete",
}: {
  onEdit: () => void;
  onDelete: () => void;
  editLabel?: string;
  deleteLabel?: string;
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
          {editLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <TrashIcon />
          {deleteLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Full-bleed "no records yet" state shown in place of the table. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** Full-bleed error state with a retry action shown in place of the table. */
export function ErrorState({
  title,
  description = "The API may be down or unreachable.",
  onRetry,
  error,
}: {
  title: string;
  description?: string;
  onRetry: () => void;
  /** The failed query's error — its API request id (if any) is surfaced for reporting. */
  error?: unknown;
}) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
      <RequestIdNote requestId={requestId} />
      <Button variant="outline" onClick={onRetry}>
        <ArrowPathIcon />
        Retry
      </Button>
    </div>
  );
}
