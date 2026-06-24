"use client";

import { CheckIcon, ChevronDownIcon } from "@heroicons/react/16/solid";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { type QuickViewData } from "@/components/quick-view-fields";
import { QuickViewEye } from "@/components/quick-view-eye";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { cn } from "@/lib/utils";

/**
 * A reusable, controlled **searchable multi-select** entity picker (issue #213) — the MULTI-select
 * sibling of {@link Combobox} (#199). It composes the same vendored primitives (Popover + cmdk
 * Command) and the same two modes, but holds **several** selections (tracked by entity key) and keeps
 * the popover open while toggling, so the user can browse a large directory and pick many entities in
 * one interaction. **No new `ui/*` primitive** — like `MultiSelectFilter` (#198) and `Combobox`
 * (#199), it is an app-level composition of the vendored ones.
 *
 * Two modes, chosen by whether {@link EntityMultiSelectProps.onSearchChange} is supplied (mirrors
 * {@link Combobox}):
 *
 *  - **client-filter** (default — small/curated lists, e.g. the applications catalog): cmdk filters
 *    the in-memory `items` by the typed query; the caller passes the full list once.
 *  - **server-search** (big, growable lists — assets): pass `onSearchChange`. cmdk's built-in filter
 *    is disabled (`shouldFilter={false}`); the input is debounced and the settled query handed back so
 *    the caller can feed a `q`-driven paged hook (ADR-0030). The caller supplies the matching `items`
 *    + `loading`. The already-fetched first page shows on open (issue #218) — typing only narrows it.
 *
 * Selection is tracked by each item's stable KEY (the entity id), never the visible label — so a
 * chosen id survives the list paging out from under it (the active-filter chips, resolved by-id on the
 * page, keep showing the label). Toggling a row adds/removes its id from {@link selected} and the menu
 * stays open (each item `preventDefault`s cmdk's auto-close on select).
 *
 * Design-system note (ADR-0049): the surface is the bone `bg-popover`; the indigo accent shows only as
 * the selected-row tint (`bg-accent`) + the check glyph and the trigger count is neutral
 * `text-muted-foreground` — never small coloured text on the bone canvas. Motion reuses the Popover's
 * enter/exit classes, already behind the global `prefers-reduced-motion` guard.
 */
export interface EntityMultiSelectItem {
  /** The entity id — the value tracked in `selected` / URL state / sent to the server. */
  value: string;
  /** The human-readable label rendered in the menu. */
  label: string;
  /** Optional extra terms to match in client-filter mode (e.g. an asset tag or serial). */
  keywords?: string[];
  disabled?: boolean;
}

export interface EntityMultiSelectProps {
  /** The filter's name, shown in the trigger and as a count (e.g. "Assets (2)"). Already translated. */
  label: string;
  /** The options to render. In server-search mode this is the current query's page. */
  items: EntityMultiSelectItem[];
  /** Currently-selected entity ids (controlled). */
  selected: string[];
  /** Called with the next full selection whenever an option is toggled. */
  onChange: (next: string[]) => void;
  /** Search box placeholder (already translated). */
  searchPlaceholder?: string;
  /** Shown when the (filtered/searched) list is empty (already translated). */
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Server-search mode switch: when provided, cmdk's built-in filter is disabled and the debounced
   * query is handed back here for a `q`-driven paged hook. Omit it for client-filter mode.
   */
  onSearchChange?: (query: string) => void;
  /** Server-search: whether the backing query is in flight (renders a loading row). */
  loading?: boolean;
  /** Debounce (ms) before `onSearchChange` fires. Default 250. */
  debounceMs?: number;
  /** Popover alignment. Default `start`. */
  align?: "start" | "center" | "end";
  /**
   * Quick View opt-in (epic #788, wave 2 — ADR-0072). Mirrors {@link Combobox}'s `quickView`: when
   * supplied, each row gains a focusable eye button (before the selection check) that opens a
   * {@link QuickViewPopover} preview of that entity. The callback maps a row's `value` (entity id) to
   * the {@link QuickViewData} the wrapper ALREADY loaded (zero extra fetch) — return `null` to skip the
   * eye for a row with no previewable data. OMIT this prop entirely (the default) and no eye renders —
   * zero behavior change for non-entity multi-selects. The picker owns the open/pinned/single-open +
   * focus-return interaction; the wrapper only supplies the data.
   */
  quickView?: (value: string) => QuickViewData | null;
}

export function EntityMultiSelect({
  label,
  items,
  selected,
  onChange,
  searchPlaceholder,
  emptyText,
  disabled,
  className,
  onSearchChange,
  loading = false,
  debounceMs = 250,
  align = "start",
  quickView,
}: EntityMultiSelectProps) {
  const t = useTranslations("shared");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();

  // Quick View (ADR-0072): lifted here so only ONE preview is open at a time across all rows, and so
  // a pinned preview survives the cmdk selection moving. `pinned` distinguishes a transient hover
  // preview (auto-closes on leave) from a click/Enter/Space-pinned one (stays + shows the footer).
  const [openQuickViewId, setOpenQuickViewId] = useState<string | null>(null);
  const [quickViewPinned, setQuickViewPinned] = useState(false);

  // Closing the picker also dismisses any open preview (it's anchored to a row that's about to unmount).
  function closeQuickView() {
    setOpenQuickViewId(null);
    setQuickViewPinned(false);
  }

  const isServerSearch = onSearchChange !== undefined;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const count = selectedSet.size;

  // Server-search: debounce the raw input and hand the settled query back to the caller's paged hook.
  const debouncedQuery = useDebouncedValue(query, debounceMs);
  const onSearchChangeRef = useRef(onSearchChange);
  useEffect(() => {
    onSearchChangeRef.current = onSearchChange;
  });
  useEffect(() => {
    onSearchChangeRef.current?.(debouncedQuery);
  }, [debouncedQuery]);

  function toggle(value: string) {
    if (selectedSet.has(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
    // Keep the popover open so several entities can be picked in one pass.
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Reset the query on close so reopening starts clean (server-search reopens on its first page).
    if (!next) {
      setQuery("");
      // A preview is anchored to a row that's about to unmount — dismiss it with the picker.
      closeQuickView();
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        type="button"
        role="combobox"
        aria-expanded={open}
        disabled={disabled}
        aria-label={
          count > 0
            ? t("multiSelect.triggerLabelWithCount", { label, count })
            : label
        }
        className={cn(
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
          className,
        )}
      >
        <span className="truncate text-left">
          {label}
          {count > 0 ? (
            <span className="ml-1 text-muted-foreground">({count})</span>
          ) : null}
        </span>
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-(--radix-popover-trigger-width) min-w-56 p-0"
      >
        <Command shouldFilter={!isServerSearch}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={
              searchPlaceholder ?? t("multiSelect.searchPlaceholder")
            }
          />
          <CommandList id={listId} aria-label={searchPlaceholder}>
            {loading ? (
              <p
                className="py-6 text-center text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {t("multiSelect.loading")}
              </p>
            ) : (
              <>
                <CommandEmpty>
                  {emptyText ?? t("multiSelect.empty")}
                </CommandEmpty>
                <CommandGroup>
                  {items.map((item) => {
                    const view = quickView?.(item.value) ?? null;
                    return (
                      <CommandItem
                        key={item.value}
                        // cmdk matches on `value`; in client-filter mode we want the LABEL searchable
                        // while still toggling by KEY, so pass label+key (+keywords) for matching and
                        // resolve the chosen key via the closure — never the value text.
                        value={
                          isServerSearch
                            ? item.value
                            : `${item.label} ${item.value}`
                        }
                        keywords={item.keywords}
                        disabled={item.disabled}
                        // Keep the menu open while toggling several entities (#198 pattern).
                        onSelect={() => toggle(item.value)}
                        // `group/row` so the eye can reveal on hover OR on the cmdk-selected row.
                        className="group/row"
                      >
                        <span className="line-clamp-1">{item.label}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          {/* Eye before the check so the selection glyph stays the row's last element. */}
                          {view ? (
                            <QuickViewEye
                              view={view}
                              open={openQuickViewId === item.value}
                              pinned={
                                openQuickViewId === item.value && quickViewPinned
                              }
                              onPreview={() => {
                                setOpenQuickViewId(item.value);
                                setQuickViewPinned(false);
                              }}
                              onPin={() => {
                                setOpenQuickViewId(item.value);
                                setQuickViewPinned(true);
                              }}
                              onClose={closeQuickView}
                            />
                          ) : null}
                          <CheckIcon
                            className={cn(
                              "size-4",
                              selectedSet.has(item.value)
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                          />
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
