"use client";

import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpDownIcon,
  DocumentDuplicateIcon,
  EllipsisVerticalIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { ChevronDownIcon, ChevronUpIcon, XMarkIcon } from "@heroicons/react/16/solid";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

/** Number of mobile skeleton cards to mirror the loading state below `md`. */
const SKELETON_CARD_KEYS = ["a", "b", "c"] as const;

/**
 * The select-all header state a list feeds {@link ResourceTable} to enable multi-row selection (the
 * bulk / batch-action wave). When present, the table renders a leading checkbox column whose header
 * toggles the whole visible page; rows render their own {@link SelectCell}. Wire this straight from
 * `useRowSelection(...)`. ADMIN-gate the whole thing at the call site (`useCanWrite()`) — omit
 * `selection` entirely for non-admins so the column never appears.
 */
export interface ResourceTableSelection {
  /** Whether the leading checkbox column renders at all (and a header select-all is shown). */
  enabled: boolean;
  /** True when every visible row is selected. */
  allSelected: boolean;
  /** True when some but not all visible rows are selected (header shows an indeterminate dash). */
  someSelected: boolean;
  /** Select (true) or clear (false) every visible row. */
  onToggleAll: (selected: boolean) => void;
  /** Accessible label for the header checkbox (e.g. "Select all assets"). */
  selectAllLabel?: string;
}

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
  /**
   * Optional "Clear filters" affordance shown alongside {@link filteredEmptyMessage} on the
   * filtered-empty row, so a user who filtered everything out can recover in place. Pass a `<button>`
   * / `<Link>` node (the page owns the clear handler).
   */
  filteredEmptyAction?: ReactNode;
  /** The table rows, rendered (at `md` and up) when not loading / filtered-empty. */
  children?: ReactNode;
  /**
   * Optional mobile card list, rendered *below* `md` in place of the table. Pass the SAME rows
   * already filtered/sorted/paged, re-laid-out as stacked cards (see {@link ResourceCard}) so each
   * list becomes touch-friendly on narrow viewports. When omitted, the table just scrolls
   * horizontally as before. Loading and filtered-empty states are mirrored automatically.
   */
  mobileChildren?: ReactNode;
  /**
   * Enables multi-row selection: when set (and `enabled`), the table renders a leading checkbox
   * column with a header select-all. Rows opt in by rendering a leading {@link SelectCell}; mobile
   * cards pass `selectable`/`selected`/`onSelectedChange` to {@link ResourceCard}. See
   * {@link ResourceTableSelection}.
   */
  selection?: ResourceTableSelection;
}

/**
 * Bordered table shell with a header derived from `columns`, plus the two in-table states (loading
 * skeletons and filtered-empty). Pages own the rows, the filter bar and the no-data / error branches
 * (via EmptyState/ErrorState). The shared scaffolding behind every resource list — see ADR-0020.
 *
 * Responsive (the follow-on bulk-action wave consumes this API): the `<table>` renders at `md` and
 * up; below `md`, if `mobileChildren` is supplied, it renders instead as a stacked card list (built
 * from {@link ResourceCard}). Both branches receive the same already-filtered/sorted/paged rows, so
 * the page builds its data once and hands the table a desktop (`children`) and a mobile
 * (`mobileChildren`) projection of it.
 */
export function ResourceTable({
  columns,
  isLoading = false,
  skeletonRows = DEFAULT_SKELETON_ROWS,
  isFilteredEmpty = false,
  filteredEmptyMessage = "No matching results.",
  filteredEmptyAction,
  children,
  mobileChildren,
  selection,
}: ResourceTableProps) {
  const hasMobile = mobileChildren !== undefined;
  const selectable = selection?.enabled ?? false;
  // The leading checkbox column adds one cell — fold it into skeleton rows and the empty colSpan.
  const colSpan = columns.length + (selectable ? 1 : 0);
  return (
    <>
      <div className={cn("rounded-lg border", hasMobile && "hidden md:block")}>
        <Table>
          <TableHeader>
            <TableRow>
              {selectable ? (
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      selection?.allSelected
                        ? true
                        : selection?.someSelected
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(value) =>
                      selection?.onToggleAll(value === true)
                    }
                    aria-label={selection?.selectAllLabel ?? "Select all rows"}
                  />
                </TableHead>
              ) : null}
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
                  {selectable ? (
                    <TableCell>
                      <Skeleton className="size-4 rounded-[4px]" />
                    </TableCell>
                  ) : null}
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
                  colSpan={colSpan}
                  className="h-24 text-center text-muted-foreground"
                  aria-live="polite"
                >
                  <FilteredEmpty
                    message={filteredEmptyMessage}
                    action={filteredEmptyAction}
                  />
                </TableCell>
              </TableRow>
            ) : (
              children
            )}
          </TableBody>
        </Table>
      </div>

      {hasMobile ? (
        <div className="space-y-3 md:hidden">
          {isLoading ? (
            SKELETON_CARD_KEYS.slice(0, Math.min(skeletonRows, 3)).map(
              (key) => (
                <div key={key} className="space-y-3 rounded-lg border p-4">
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/3" />
                </div>
              ),
            )
          ) : isFilteredEmpty ? (
            <div
              className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground"
              aria-live="polite"
            >
              <FilteredEmpty
                message={filteredEmptyMessage}
                action={filteredEmptyAction}
              />
            </div>
          ) : (
            mobileChildren
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * The leading selection cell for a desktop table row — a checkbox bound to one row's selected state.
 * Render it as the FIRST `<TableCell>` of each row when the table's `selection` is enabled, and set
 * `data-state={selected ? "selected" : undefined}` on the row so the shared `data-[state=selected]`
 * row styling highlights it. The `onClick` stop-propagation keeps a click on the box from also
 * triggering a row-level navigation handler.
 */
export function SelectCell({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible label (e.g. `Select ${asset.name}`). */
  label: string;
}) {
  return (
    <TableCell
      className="w-10"
      onClick={(event) => event.stopPropagation()}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-label={label}
      />
    </TableCell>
  );
}

/** The filtered-empty message + an optional inline "Clear filters" recovery action. */
function FilteredEmpty({
  message,
  action,
}: {
  message: ReactNode;
  action?: ReactNode;
}) {
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <span>{message}</span>
      {action}
    </span>
  );
}

/**
 * One mobile card for the {@link ResourceTable}'s `mobileChildren` slot — a stacked, touch-friendly
 * projection of a table row for viewports below `md`. The card's whole surface links to the row's
 * detail (pass `href`); status badges, owner avatars and quick-adjust controls go in `meta` and
 * `actions` so they stay visible and ≥44px-tappable. Per-row Edit/Delete and the like go in
 * `actions` (rendered as a sibling footer, not nested in the anchor, to avoid an
 * interactive-element-in-anchor violation).
 */
export function ResourceCard({
  href,
  title,
  badge,
  meta,
  actions,
  selectable = false,
  selected = false,
  onSelectedChange,
  selectLabel = "Select row",
}: {
  /** Detail route the card body links to. Omit for a non-navigable card. */
  href?: string;
  /** The primary label (e.g. the resource name). */
  title: ReactNode;
  /** Optional trailing badge beside the title (e.g. a StatusBadge). */
  badge?: ReactNode;
  /** Secondary key/value lines (category, stock, owners, updated, …). */
  meta?: ReactNode;
  /** Row of controls (quick-adjust, RowActions) pinned to the card footer. */
  actions?: ReactNode;
  /**
   * Enables a leading selection checkbox on the card (the mobile twin of {@link SelectCell}). Pair
   * with `selected`/`onSelectedChange` from `useRowSelection(...)`; ADMIN-gate at the call site.
   */
  selectable?: boolean;
  /** Whether this card is selected (controlled). */
  selected?: boolean;
  /** Toggle this card's selected state. */
  onSelectedChange?: (selected: boolean) => void;
  /** Accessible label for the card's checkbox (e.g. `Select ${asset.name}`). */
  selectLabel?: string;
}) {
  const header = (
    <div className="flex items-start justify-between gap-2">
      <span className="min-w-0 font-medium break-words">{title}</span>
      {badge ? <span className="shrink-0">{badge}</span> : null}
    </div>
  );
  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-colors",
        selectable && selected && "border-primary/40 bg-muted",
      )}
      data-state={selectable && selected ? "selected" : undefined}
    >
      <div className="flex items-start gap-3">
        {selectable ? (
          <Checkbox
            checked={selected}
            onCheckedChange={(value) => onSelectedChange?.(value === true)}
            aria-label={selectLabel}
            className="mt-0.5 shrink-0"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {href ? (
            <Link
              href={href}
              className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {header}
            </Link>
          ) : (
            header
          )}
        </div>
      </div>
      {meta ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
          {meta}
        </dl>
      ) : null}
      {actions ? (
        <div className="mt-3 flex items-center justify-end gap-2 border-t pt-3">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** A single key/value line inside a {@link ResourceCard}'s `meta` grid. */
export function ResourceCardMeta({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * Per-row actions dropdown (Edit / optional Clone / Delete) shared by resource tables. `onClone` is
 * OPTIONAL and additive: when provided, a "Clone" item renders between Edit and the destructive
 * Delete (separated from Delete) — it opens the create flow pre-filled from this row (issue #125).
 * Existing call sites that don't pass it are unaffected. Gate `onClone` behind `useCanWrite()` at the
 * call site (a clone is a create) and never wire it in the archived view.
 */
export function RowActions({
  onEdit,
  onClone,
  onDelete,
  editLabel = "Edit",
  cloneLabel = "Clone",
  deleteLabel = "Delete",
}: {
  onEdit: () => void;
  /** When set, render a "Clone" item that opens the create flow pre-filled from this row. */
  onClone?: () => void;
  onDelete: () => void;
  editLabel?: string;
  cloneLabel?: string;
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
        {onClone ? (
          <DropdownMenuItem onSelect={onClone}>
            <DocumentDuplicateIcon />
            {cloneLabel}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <TrashIcon />
          {deleteLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A single per-row "Restore" button for the archived (`deleted=only`) view, replacing the Edit/Delete
 * dropdown — a soft-deleted row can only be brought back, not edited or re-deleted. Wire `onRestore`
 * to the per-entity `POST /<resource>/:id/restore` mutation; the page owns the toast + invalidation.
 */
export function RestoreRowAction({
  onRestore,
  disabled = false,
  label = "Restore",
}: {
  onRestore: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onRestore}
      disabled={disabled}
    >
      <ArrowUturnLeftIcon />
      {label}
    </Button>
  );
}

/**
 * The contextual batch-action bar surfaced when one or more rows are selected (the bulk wave). It is
 * sticky at the bottom of the viewport so it stays reachable while scrolling a long list, shows the
 * selected count + a "Clear" affordance, and renders the page-supplied `actions` (bulk delete /
 * restore / status-change / revoke buttons). Renders nothing when `count` is 0, so a page can mount
 * it unconditionally. ADMIN-gate at the call site — the selection column shouldn't even appear for a
 * non-admin.
 */
export function BatchActionBar({
  count,
  onClear,
  children,
  noun = "item",
}: {
  /** How many rows are selected (the bar hides at 0). */
  count: number;
  /** Clear the whole selection. */
  onClear: () => void;
  /** The bulk action buttons for this list. */
  children: ReactNode;
  /** Singular noun for the count label (e.g. "asset"); pluralized with a trailing "s". */
  noun?: string;
}) {
  if (count === 0) return null;
  return (
    <div
      className="sticky bottom-4 z-20 mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-center sm:justify-between"
      role="region"
      aria-label="Bulk actions"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium tabular-nums" aria-live="polite">
          {count} {noun}
          {count === 1 ? "" : "s"} selected
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <XMarkIcon className="size-4" />
          Clear
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
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
 * A sortable column header — a button that toggles asc/desc and shows the direction. Sorting is
 * **server-side and authoritative** across the full result set (ADR-0030 amendment): wire the
 * `onToggle` to `useListParams().toggleSort(field)` so the order is recomputed by the API over every
 * row, not just the page on screen. Only expose columns in the resource's server sort allowlist as
 * sortable. Use inside a `ResourceColumn.header`.
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
