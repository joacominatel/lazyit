"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Page-scoped multi-row selection for the resource lists (the bulk / batch-action wave).
 *
 * Selection is held as a `Set<string>` of row ids in component state — intentionally NOT in the URL:
 * a transient "what am I about to act on" set shouldn't be bookmarkable, and it must reset whenever
 * the visible set changes (a new page/filter/search). The list passes the *currently visible* row
 * ids (`visibleIds`) so the header "select all" toggles only this page and the partial/all state is
 * derived against it; ids selected on a page that's no longer visible are pruned by {@link sync} (the
 * list calls it when its rows change) so a batch never targets a row the user can't see.
 *
 * Returned as a single object so a list can spread it into the table's `selection` prop and the
 * batch-action bar. The bulk actions are lifecycle ops, so gate selection at the call site on
 * `can('<domain>:delete')` (the archived bulk-restore lists are reached only by ADMINs, who hold it);
 * this hook is purely UI state.
 */
export interface RowSelection {
  /** The currently selected row ids. */
  selectedIds: string[];
  /** How many rows are selected. */
  count: number;
  /** Whether `id` is selected. */
  isSelected: (id: string) => boolean;
  /** Toggle one row (used by a row checkbox). */
  toggle: (id: string) => void;
  /** Set one row's selected state explicitly (used by the controlled checkbox `onCheckedChange`). */
  setSelected: (id: string, selected: boolean) => void;
  /** True when every visible row is selected (and there is at least one). */
  allSelected: boolean;
  /** True when some — but not all — visible rows are selected (header indeterminate). */
  someSelected: boolean;
  /** Select every visible row when `selected`, else clear the visible rows from the set. */
  toggleAll: (selected: boolean) => void;
  /** Clear the whole selection. */
  clear: () => void;
}

/**
 * @param visibleIds the ids of the rows currently rendered (this page, after filters). Drives the
 * header select-all / indeterminate state and bounds `toggleAll`.
 */
export function useRowSelection(visibleIds: string[]): RowSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setOne = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (on: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [visibleIds],
  );

  const clear = useCallback(() => setSelected(new Set()), []);

  const { allSelected, someSelected, selectedIds } = useMemo(() => {
    // Only count ids that are actually visible — a selection lingering from a now-hidden page must
    // not keep the header checked or feed a batch.
    const visibleSelected = visibleIds.filter((id) => selected.has(id));
    const ids = [...selected].filter((id) => visibleIds.includes(id));
    return {
      selectedIds: ids,
      allSelected:
        visibleIds.length > 0 && visibleSelected.length === visibleIds.length,
      someSelected:
        visibleSelected.length > 0 &&
        visibleSelected.length < visibleIds.length,
    };
  }, [selected, visibleIds]);

  return {
    selectedIds,
    count: selectedIds.length,
    isSelected,
    toggle,
    setSelected: setOne,
    allSelected,
    someSelected,
    toggleAll,
    clear,
  };
}
