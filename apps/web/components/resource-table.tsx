"use client";

import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpDownIcon,
  EllipsisVerticalIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/16/solid";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
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
                aria-live="polite"
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
    <div
      className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center"
      aria-live="polite"
    >
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
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center"
      role="status"
      aria-live="polite"
    >
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

/**
 * Offset-based pagination footer for a `Page<T>` list (ADR-0030). Renders the visible range, the
 * total count and prev/next controls; the prev/next math is offset-based to match the contract
 * (`{ total, limit, offset }`). Pages keep `keepPreviousData` on the list query so paging doesn't
 * flash the skeleton — `isFetching` dims the controls while the next page resolves. Renders nothing
 * when everything fits on one page.
 */
export function Pagination({
  total,
  limit,
  offset,
  itemCount,
  onOffsetChange,
  isFetching = false,
}: {
  /** Total rows across all pages (from the envelope's `total`). */
  total: number;
  /** Current page size (the envelope's `limit`). */
  limit: number;
  /** Current zero-based window offset (the envelope's `offset`). */
  offset: number;
  /** Rows actually on this page (`items.length`) — used for the visible range's upper bound. */
  itemCount: number;
  /** Move to a new zero-based offset (the page clamps it into range). */
  onOffsetChange: (offset: number) => void;
  /** True while a page change is in flight — dims the controls. */
  isFetching?: boolean;
}) {
  // A single page that fits everything needs no control.
  if (total <= limit && offset === 0) return null;

  const from = total === 0 ? 0 : offset + 1;
  const to = offset + itemCount;
  const hasPrev = offset > 0;
  const hasNext = to < total;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-between gap-3 sm:flex-row",
        isFetching && "opacity-60",
      )}
    >
      <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
        {total === 0 ? (
          "No results"
        ) : (
          <>
            Showing <span className="font-medium text-foreground">{from}</span>–
            <span className="font-medium text-foreground">{to}</span> of{" "}
            <span className="font-medium text-foreground">{total}</span>
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        >
          <ChevronLeftIcon />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNext}
          onClick={() => onOffsetChange(offset + limit)}
        >
          Next
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}

/** A column's current sort state, or null when it isn't the active sort column. */
export type SortDirection = "asc" | "desc";

/**
 * A sortable column header — a button that toggles asc/desc and shows the direction. Sorting here is
 * **client-side over the current page** (the `Page<T>` contract carries no server sort param,
 * ADR-0030), so it reorders only the rows on screen. Use inside a `ResourceColumn.header`.
 */
export function SortableHeader({
  label,
  active,
  direction,
  onToggle,
  className,
}: {
  label: ReactNode;
  /** True when this is the active sort column. */
  active: boolean;
  /** The active direction (only meaningful when `active`). */
  direction: SortDirection;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        active ? "text-foreground" : "text-muted-foreground",
        className,
      )}
      aria-label={`Sort by ${typeof label === "string" ? label : "column"}`}
    >
      {label}
      {active ? (
        direction === "asc" ? (
          <ChevronUpIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )
      ) : (
        <ChevronUpDownIcon className="size-3.5 opacity-50" />
      )}
    </button>
  );
}
