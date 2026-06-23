"use client";

import { useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The page-size options offered across the list views (issue #694). 200 = the API cap (ADR-0030). */
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

interface RowsPerPageSelectProps {
  /** Current page size (the list's `limit`). */
  value: number;
  /** Commit a new page size — wire to `useListParams().setLimit`, which clamps and resets paging. */
  onChange: (limit: number) => void;
  /** Extra classes for the trigger (e.g. a fixed width to match the filter bar). */
  className?: string;
}

/**
 * "Rows per page" control for the list toolbars (Users, Assets, Reports). Reuses the shared
 * shadcn {@link Select} the filter bars already use, so it reads consistently with the other
 * dropdowns. The selected `limit` is written to the URL by `setLimit` (clamped to the API cap).
 *
 * If the current `value` isn't one of the presets (e.g. a hand-edited `?limit=37`), it's surfaced
 * as an extra option so the trigger still reflects the real page size rather than reading blank.
 */
export function RowsPerPageSelect({
  value,
  onChange,
  className,
}: RowsPerPageSelectProps) {
  const tc = useTranslations("common");
  const options = (PAGE_SIZE_OPTIONS as readonly number[]).includes(value)
    ? PAGE_SIZE_OPTIONS
    : [...PAGE_SIZE_OPTIONS, value].sort((a, b) => a - b);

  return (
    <Select
      value={String(value)}
      onValueChange={(next) => onChange(Number(next))}
    >
      <SelectTrigger className={className} aria-label={tc("rowsPerPage")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((size) => (
          <SelectItem key={size} value={String(size)}>
            {tc("rowsPerPage")}: {size}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
