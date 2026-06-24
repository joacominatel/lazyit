"use client";

import { CheckIcon, ChevronUpDownIcon, EyeIcon } from "@heroicons/react/16/solid";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { titleFor, type QuickViewData } from "@/components/quick-view-fields";
import { QuickViewPopover } from "@/components/quick-view-popover";
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
 * One reusable, controlled searchable picker (issue #199) — Popover + cmdk Command — that replaces
 * the plain entity `Select`s across the app. It drops into the existing `Field`/`FieldError` +
 * react-hook-form `Controller` contract: pass `id` for the label association and
 * `aria-invalid={fieldState.invalid}` so a validation error rings the trigger exactly like a
 * `SelectTrigger` does, and it stays composable inside `CreatableField` (it renders as that wrapper's
 * single child).
 *
 * Two modes, chosen by whether {@link ComboboxProps.onSearchChange} is supplied:
 *
 *  - **client-filter** (default — small/medium curated lists, e.g. asset/consumable categories):
 *    cmdk filters the in-memory `items` by the typed query. The caller passes the full list once.
 *
 *  - **server-search** (big, growable lists — users, assets, asset models): pass `onSearchChange`.
 *    cmdk's built-in filter is disabled (`shouldFilter={false}`); the input is debounced and the
 *    debounced query handed back so the caller can feed a `q`-driven paged hook (ADR-0030). The
 *    caller then supplies the matching `items` + `loading`. We render loading / empty states (and,
 *    when opted in, a type-to-search hint) so the picker reads correctly to a screen reader at every
 *    step.
 *
 * By default the server-search picker shows the **first page** the caller already fetched (with
 * `q: undefined`) the moment it opens — typing only narrows it, it is never a precondition to see
 * options (issue #218). A caller with a genuinely huge directory can opt back into a typed
 * precondition by passing {@link ComboboxProps.minQueryLength} (e.g. `1`), which restores the
 * type-to-search hint until the query reaches that length.
 *
 * Selection is tracked by the item's stable KEY (the entity id), never the visible label — so
 * duplicate labels never collide and the chosen value survives the list paging out from under it
 * (the trigger renders {@link ComboboxProps.selectedLabel} when the selected row isn't on the current
 * page).
 *
 * Design-system note (ADR-0049): the surface is the bone `bg-popover`; the indigo accent shows only
 * as the selected-row tint (`bg-accent`) and the check glyph — never as small coloured text. Motion
 * reuses the Popover's enter/exit classes, already behind the global `prefers-reduced-motion` guard.
 */
export interface ComboboxItem {
  value: string;
  label: string;
  /** Optional extra terms to match in client-filter mode (e.g. a SKU or email). */
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxProps {
  /** The selected item's key (entity id), or "" / undefined when nothing is chosen. */
  value?: string;
  /** Called with the newly-selected key. Selecting the current value again clears it (toggle). */
  onValueChange: (value: string) => void;
  /** The options to render. In server-search mode this is the current query's page. */
  items: ComboboxItem[];
  /** Trigger text when nothing is selected. Defaults to the localized `common.combobox.placeholder`. */
  placeholder?: string;
  /** Search box placeholder. Defaults to the localized `common.combobox.searchPlaceholder`. */
  searchPlaceholder?: string;
  /** Shown when the (filtered/searched) list is empty. Defaults to the localized `common.combobox.empty`. */
  emptyText?: string;
  disabled?: boolean;
  /** Forwarded to the trigger for the `FieldLabel htmlFor` association. */
  id?: string;
  /** Forwarded to the trigger so a `Controller` field error rings it (matches `SelectTrigger`). */
  "aria-invalid"?: boolean;
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
  /**
   * The label of the currently-selected value, for when that row isn't in `items` (server-search:
   * the selection may have paged out). Falls back to the matching item's label, then the raw value.
   */
  selectedLabel?: string;
  /**
   * Server-search opt-in: require at least this many typed characters before any options are shown,
   * rendering {@link ComboboxProps.typeToSearchText} until then. Defaults to `0` — the picker shows
   * the already-fetched first page on open and typing only narrows it (issue #218). Raise it (e.g.
   * `1`) only for directories large enough to warrant a typed precondition.
   */
  minQueryLength?: number;
  /**
   * Server-search: copy shown before the query reaches {@link ComboboxProps.minQueryLength}. Only
   * surfaced when `minQueryLength > 0`. Defaults to the localized `common.combobox.typeToSearch`.
   */
  typeToSearchText?: string;
  /**
   * Server-search loading copy (screen-reader friendly). Defaults to the localized
   * `common.combobox.loading`.
   */
  loadingText?: string;
  /**
   * Quick View opt-in (epic #788, wave 1 — ADR-0072). When supplied, each row gains a focusable eye
   * button that opens a {@link QuickViewPopover} preview of that entity. The callback maps a row's
   * `value` (entity id) to the {@link QuickViewData} the wrapper ALREADY loaded (zero extra fetch) —
   * return `null` to skip the eye for a row with no previewable data. OMIT this prop entirely (the
   * default) and no eye renders — zero behavior change for non-entity pickers (the category list, the
   * workflow data-mapping editor). The Combobox owns the open/pinned/single-open + focus-return
   * interaction; the wrapper only supplies the data.
   */
  quickView?: (value: string) => QuickViewData | null;
}

export function Combobox({
  value,
  onValueChange,
  items,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  id,
  "aria-invalid": ariaInvalid,
  className,
  onSearchChange,
  loading = false,
  debounceMs = 250,
  selectedLabel,
  minQueryLength = 0,
  typeToSearchText,
  loadingText,
  quickView,
}: ComboboxProps) {
  // Defaults route through `common.combobox.*` so an async-search picker announces its empty/loading/
  // hint states in the active locale (issue #506); an explicit prop still wins for screen-specific copy.
  const tc = useTranslations("common.combobox");
  placeholder ??= tc("placeholder");
  searchPlaceholder ??= tc("searchPlaceholder");
  emptyText ??= tc("empty");
  typeToSearchText ??= tc("typeToSearch");
  loadingText ??= tc("loading");

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

  // Server-search: debounce the raw input and hand the settled query back to the caller's paged hook.
  const debouncedQuery = useDebouncedValue(query, debounceMs);

  // Keep the latest callback in a ref so the notify effect can stay keyed only on the settled query
  // (the caller's callback identity is its own concern; re-running on it would spam refetches).
  const onSearchChangeRef = useRef(onSearchChange);
  useEffect(() => {
    onSearchChangeRef.current = onSearchChange;
  });
  useEffect(() => {
    onSearchChangeRef.current?.(debouncedQuery);
  }, [debouncedQuery]);

  // The visible label for the trigger: the explicit selectedLabel wins (survives paging in
  // server-search), then the matching loaded item, then the raw value as a last resort.
  const triggerLabel = useMemo(() => {
    if (!value) return undefined;
    if (selectedLabel) return selectedLabel;
    return items.find((item) => item.value === value)?.label ?? value;
  }, [value, selectedLabel, items]);

  function handleSelect(nextValue: string) {
    // Toggle: re-selecting the current value clears it (consistent with how an empty pick reads).
    onValueChange(nextValue === value ? "" : nextValue);
    setOpen(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Reset the query when closing so reopening starts clean (server-search reopens on its first page).
    if (!next) {
      setQuery("");
      // A preview is anchored to a row that's about to unmount — dismiss it with the picker.
      closeQuickView();
    }
  }

  // Server-search shows the already-fetched first page on open by default (issue #218). A caller that
  // wants a typed precondition opts in via `minQueryLength > 0`; until the query reaches it we render
  // the type-to-search hint instead of the list.
  const showTypeToSearch =
    isServerSearch &&
    minQueryLength > 0 &&
    debouncedQuery.trim().length < minQueryLength;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-invalid={ariaInvalid || undefined}
        disabled={disabled}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          className
        )}
      >
        <span
          className={cn(
            "line-clamp-1 text-left",
            !triggerLabel && "text-muted-foreground"
          )}
        >
          {triggerLabel ?? placeholder}
        </span>
        <ChevronUpDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
      >
        <Command shouldFilter={!isServerSearch}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
          />
          <CommandList id={listId} aria-label={searchPlaceholder}>
            {showTypeToSearch ? (
              <p className="py-6 text-center text-sm text-muted-foreground" role="status">
                {typeToSearchText}
              </p>
            ) : loading ? (
              <p
                className="py-6 text-center text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {loadingText}
              </p>
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  {items.map((item) => {
                    const view = quickView?.(item.value) ?? null;
                    return (
                      <CommandItem
                        key={item.value}
                        // cmdk matches on `value`; in client-filter mode we want the LABEL searchable
                        // while still selecting by KEY, so we pass label+key (+keywords) for matching
                        // and resolve the chosen key via the closure — never the value text.
                        value={
                          isServerSearch
                            ? item.value
                            : `${item.label} ${item.value}`
                        }
                        keywords={item.keywords}
                        disabled={item.disabled}
                        onSelect={() => handleSelect(item.value)}
                        // `group/row` so the eye can reveal on hover OR on the cmdk-selected row.
                        className="group/row"
                      >
                        <span className="line-clamp-1">{item.label}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1">
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
                              item.value === value ? "opacity-100" : "opacity-0"
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

/** Intent delay (ms) before a hover opens the Quick View preview — long enough that skimming the
 *  list with the mouse doesn't flicker previews, short enough to feel instant on a deliberate hover. */
const QUICK_VIEW_HOVER_MS = 120;

/**
 * The per-row eye affordance (ADR-0072). A real `<button>` (not a hover-only glyph): it is `opacity-0`
 * and revealed by `group-hover/row` OR `group-data-[selected=true]/row` — so it is keyboard-VISIBLE on
 * the cmdk-selected row (arrow-key roving selection), not just on mouse hover. It is its own button
 * that `stopPropagation`/`preventDefault`s so activating it NEVER selects the row.
 *
 * Hover (after a ~120ms intent delay) opens a transient PREVIEW; click PINS it (footer + dialog
 * semantics). It is the radix `PopoverAnchor`, so Escape closes the panel and returns focus here for
 * free (radix default). One open at a time is enforced by the lifted `openQuickViewId` in the Combobox.
 *
 * KEYBOARD-OPEN is a documented v1 LIMITATION (#793): cmdk keeps DOM focus on the CommandInput and routes
 * Enter to the highlighted row's `onSelect`, so the eye — though visible on the selected row — can't be
 * opened by keyboard without fighting that roving-focus model. The eye keeps an `onKeyDown` for the
 * mouse-then-keyboard case (a focused eye), but a pure-keyboard user can't yet open the preview. The
 * clean fix (Tab-reachable selected-row eye, or a non-conflicting Command-root chord) is the follow-up.
 */
function QuickViewEye({
  view,
  open,
  pinned,
  onPreview,
  onPin,
  onClose,
}: {
  view: QuickViewData;
  open: boolean;
  pinned: boolean;
  onPreview: () => void;
  onPin: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("common.quickView");
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearHoverTimer() {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  // Clean up a pending intent timer if the row unmounts mid-hover.
  useEffect(() => clearHoverTimer, []);

  return (
    <QuickViewPopover
      view={view}
      open={open}
      pinned={pinned}
      onOpenChange={(next) => {
        // Radix drives this on Escape / outside-click — collapse our lifted state to match.
        if (!next) onClose();
      }}
      anchor={
        <button
          type="button"
          aria-label={t("trigger", { name: titleFor(view) })}
          // cmdk owns roving focus (DOM focus stays on the CommandInput); keep the eye out of the Tab
          // order so it doesn't fight that model. It's reached by mouse today; a keyboard-open path is
          // the documented v1 limitation / follow-up (#793).
          tabIndex={-1}
          className={cn(
            "flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/row:opacity-100 group-data-[selected=true]/row:opacity-100",
            open && "opacity-100",
          )}
          onMouseEnter={() => {
            clearHoverTimer();
            hoverTimer.current = setTimeout(onPreview, QUICK_VIEW_HOVER_MS);
          }}
          onMouseLeave={() => {
            clearHoverTimer();
            // Only a transient preview auto-dismisses on leave; a pinned one stays.
            if (open && !pinned) onClose();
          }}
          onClick={(event) => {
            // Don't let the click bubble to cmdk and select the row — the eye is a separate action.
            event.preventDefault();
            event.stopPropagation();
            clearHoverTimer();
            // Toggle: clicking the eye of an already-pinned preview closes it.
            if (open && pinned) onClose();
            else onPin();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              clearHoverTimer();
              if (open && pinned) onClose();
              else onPin();
            }
          }}
        >
          <EyeIcon className="size-4" />
        </button>
      }
    />
  );
}
