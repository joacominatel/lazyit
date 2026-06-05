"use client";

import { ChevronDownIcon } from "@heroicons/react/16/solid";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** One selectable option in a {@link MultiSelectFilter}. */
export interface MultiSelectOption {
  /** The value carried in URL state / sent to the server (e.g. a status enum or a category id). */
  value: string;
  /** The human-readable label rendered in the menu (already translated by the caller). */
  label: ReactNode;
  /**
   * Optional leading adornment (e.g. a token-driven `StatusDot`) — Activated Restraint (ADR-0049):
   * hue lives in a dot/tint, never as small colored text on the bone canvas.
   */
  adornment?: ReactNode;
}

/**
 * A reusable multi-select filter control (#198). Composes the vendored `DropdownMenu` +
 * `DropdownMenuCheckboxItem` primitives (no new primitive) into an outline `Button` trigger that
 * shows the filter name and a selected count (e.g. "Status (2)"); the menu is a checkbox list whose
 * toggles **OR-combine within the filter**. Selection is fully controlled by the caller (URL state
 * via `useListParams().setFilterValues` / `getFilterValues`), so the control is stateless and
 * shareable/back-navigable.
 *
 * Activated Restraint (ADR-0049): the trigger and menu are neutral surfaces (`--foreground` /
 * `--muted-foreground`); any color cue rides an option `adornment` (a `StatusDot`), never colored
 * text. Motion comes from the vendored dropdown's CSS animations, already behind the global
 * `prefers-reduced-motion` guard. The menu stays open while toggling items (each item
 * `preventDefault`s its select) so several values can be picked in one interaction.
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  className,
  align = "start",
}: {
  /** The filter's name, shown in the trigger and as the menu heading (already translated). */
  label: string;
  /** The selectable options. */
  options: MultiSelectOption[];
  /** Currently-selected values (controlled). */
  selected: string[];
  /** Called with the next full selection whenever an option is toggled. */
  onChange: (next: string[]) => void;
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const t = useTranslations("shared");
  const selectedSet = new Set(selected);
  const count = selectedSet.size;

  const toggle = (value: string, checked: boolean) => {
    if (checked) {
      if (selectedSet.has(value)) return;
      onChange([...selected, value]);
    } else {
      onChange(selected.filter((v) => v !== value));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn("justify-between gap-2", className)}
          // The selected count is read out so SR users get the active state, not just sighted ones.
          aria-label={
            count > 0
              ? t("multiSelect.triggerLabelWithCount", { label, count })
              : label
          }
        >
          <span className="truncate">
            {label}
            {count > 0 ? (
              <span className="ml-1 text-muted-foreground">({count})</span>
            ) : null}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-48">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.length === 0 ? (
          <div className="px-1.5 py-1 text-sm text-muted-foreground">
            {t("multiSelect.empty")}
          </div>
        ) : (
          options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={selectedSet.has(option.value)}
              // Keep the menu open so several values can be toggled in one pass (#198).
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => toggle(option.value, checked)}
            >
              {option.adornment}
              {option.label}
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
