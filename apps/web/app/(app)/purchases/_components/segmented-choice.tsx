"use client";

import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * A small two-or-three option choice (a line's kind, a purchase's status) as an ARIA radio group: one
 * tab stop, arrows move the choice. Later options (more line kinds) extend it without a layout change.
 */
export function SegmentedChoice<T extends string>({
  value,
  onValueChange,
  options,
  label,
  labelledBy,
  id,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  /** Accessible name of the group, used when no visible label names it. */
  label?: string;
  /** The id of the visible label that names the group (preferred over `label`). */
  labelledBy?: string;
  id?: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const next = options[(index + step + options.length) % options.length]!;
    onValueChange(next.value);
    const group = event.currentTarget;
    requestAnimationFrame(() =>
      group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(),
    );
  }

  return (
    <div
      id={id}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      onKeyDown={onKeyDown}
      className="inline-flex h-8 w-fit items-center rounded-md border bg-background p-0.5"
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "h-full rounded-[5px] px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
