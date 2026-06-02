"use client";

import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useId, useRef } from "react";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { cn } from "@/lib/utils";

interface SearchInputProps
  extends Omit<
    React.ComponentProps<"input">,
    "value" | "onChange" | "type" | "aria-label"
  > {
  /** Current input text (controlled). */
  value: string;
  /** Fires on every keystroke with the raw text — wire to your state. */
  onChange: (value: string) => void;
  /**
   * Optional self-debounce. When set, `onDebouncedChange` fires only after the
   * value has been still for this many ms. Use this OR debounce upstream with
   * `useDebouncedValue` — not both. Defaults to firing immediately (no debounce).
   */
  debounceMs?: number;
  /** Called with the debounced value when `debounceMs` is set. */
  onDebouncedChange?: (value: string) => void;
  /**
   * Accessible name for the field. Every list filter must name its search box —
   * the audit found these inputs had none. Rendered as a visually-hidden
   * `<label>` so it satisfies WCAG 4.1.2 without a visible label.
   */
  label?: string;
  /** Visible placeholder. Falls back to "Search…". Not a substitute for `label`. */
  placeholder?: string;
}

/**
 * Accessible, clearable search box: a leading magnifier, an Input, and a trailing
 * clear button that appears once there's text. Always carries an accessible name
 * (visually-hidden `<label>`, default "Search") so screen-reader users know what
 * the field filters — the audit found the per-page search Inputs had none.
 *
 * Debouncing is opt-in via `debounceMs` + `onDebouncedChange`; otherwise the
 * caller debounces upstream (the established list-page pattern with
 * `useDebouncedValue`). The visible value is always the immediate one so typing
 * stays responsive.
 */
export function SearchInput({
  value,
  onChange,
  debounceMs,
  onDebouncedChange,
  label = "Search",
  placeholder = "Search…",
  className,
  id,
  ...inputProps
}: SearchInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const inputRef = useRef<HTMLInputElement>(null);

  // Self-debounce only when asked. The hook always runs (rules of hooks); when
  // debounceMs is undefined the effect below simply never fires.
  const debounced = useDebouncedValue(value, debounceMs ?? 0);
  // Avoid emitting the initial value as a "change" before the user types.
  const firstRun = useRef(true);
  useEffect(() => {
    if (debounceMs === undefined || !onDebouncedChange) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    onDebouncedChange(debounced);
  }, [debounced, debounceMs, onDebouncedChange]);

  const hasValue = value.length > 0;

  function handleClear() {
    onChange("");
    // Return focus to the field so keyboard users keep their place.
    inputRef.current?.focus();
  }

  return (
    <div className={cn("relative", className)}>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        id={inputId}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        // pl-8 clears the leading icon; pr-8 clears the trailing clear button.
        className={cn("pl-8", hasValue && "pr-8")}
        {...inputProps}
      />
      {hasValue ? (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XMarkIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
