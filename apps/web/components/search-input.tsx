"use client";

import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { cn } from "@/lib/utils";

interface SearchInputProps
  extends Omit<
    React.ComponentProps<"input">,
    "value" | "onChange" | "type" | "aria-label"
  > {
  /**
   * Seed/sync value for the visible text. The input keeps its OWN local buffer
   * (so spaces and fast typing never get clobbered); `value` only seeds the
   * buffer initially and re-syncs it when it changes externally and differs from
   * the buffer (a cleared chip, a deep-linked `?q=`, a programmatic reset).
   * ponytail: the URL stays the source of truth for the *committed* query — we
   * just buffer the keystrokes locally and let only the debounced settle write it.
   */
  value: string;
  /**
   * Optional. Fires on every keystroke with the raw (untrimmed) text. Wire this
   * only when you need the immediate value (e.g. a purely-local `useState`
   * filter). URL-backed lists should leave it unset and use `onDebouncedChange`
   * so keystrokes don't trigger a `router.replace` per character.
   */
  onChange?: (value: string) => void;
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
 * `useDebouncedValue`). The visible value is a LOCAL buffer, so typing stays
 * responsive and trimming/URL round-trips never snap a half-typed term back
 * (issue #692: a trailing space "wouldn't type", fast typing dropped chars).
 */
export function SearchInput({
  value,
  onChange,
  debounceMs,
  onDebouncedChange,
  label,
  placeholder,
  className,
  id,
  ...inputProps
}: SearchInputProps) {
  const t = useTranslations("shared");
  const tc = useTranslations("common");
  const labelText = label ?? tc("search");
  const placeholderText = placeholder ?? t("search.placeholderShort");
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const inputRef = useRef<HTMLInputElement>(null);

  // The visible text lives in a LOCAL buffer (issue #692). It updates instantly
  // on every keystroke — spaces persist, fast typing never lags — while the
  // committed query is what the debounced settle writes to the URL. The `value`
  // prop only SEEDS this buffer and re-syncs it when it changes externally and
  // differs (a cleared chip, a deep-linked `?q=`, a programmatic reset), never
  // on the user's own keystroke. ponytail: keep the URL as the source of truth
  // for the *committed* query; buffer the in-flight keystrokes here.
  const [buffer, setBuffer] = useState(value);
  useEffect(() => {
    setBuffer((current) => (current === value ? current : value));
  }, [value]);

  // Self-debounce only when asked. The hook always runs (rules of hooks); when
  // debounceMs is undefined the effect below simply never fires.
  const debounced = useDebouncedValue(buffer, debounceMs ?? 0);
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

  const hasValue = buffer.length > 0;

  function handleChange(next: string) {
    setBuffer(next);
    onChange?.(next);
  }

  function handleClear() {
    setBuffer("");
    onChange?.("");
    onDebouncedChange?.("");
    // Return focus to the field so keyboard users keep their place.
    inputRef.current?.focus();
  }

  return (
    <div className={cn("relative", className)}>
      <label htmlFor={inputId} className="sr-only">
        {labelText}
      </label>
      <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        id={inputId}
        type="search"
        value={buffer}
        onChange={(event) => handleChange(event.target.value)}
        placeholder={placeholderText}
        // pl-8 clears the leading icon; pr-8 clears the trailing clear button.
        className={cn("pl-8", hasValue && "pr-8")}
        {...inputProps}
      />
      {hasValue ? (
        <button
          type="button"
          onClick={handleClear}
          aria-label={t("search.clearSearch")}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XMarkIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
