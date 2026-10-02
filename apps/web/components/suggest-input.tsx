"use client";

import { useTranslations } from "next-intl";
import {
  type ComponentProps,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { cn } from "@/lib/utils";
import {
  findNearDuplicate,
  initialSuggestions,
  pushRecent,
  rankSuggestions,
  type SuggestCandidate,
  suggestKeyAction,
} from "@/lib/utils/suggest";

const EMPTY: readonly string[] = [];

/**
 * The viewer's recent values for one smart-entry field, kept in this browser's `localStorage` (a
 * per-viewer convenience, never shared state — it can be empty at any time). Returns the list and a
 * `remember(value)` to call once a value is actually SAVED, so abandoned or mistyped text never
 * becomes a "recent" suggestion.
 */
export function useRecentValues(
  field: string,
): [readonly string[], (value: string | null | undefined) => void] {
  const [stored, setStored] = useLocalStorage<readonly string[]>(
    `lazyit:suggest:recent:${field}`,
    EMPTY,
  );
  // Read-tolerant: whatever another version (or a hand edit) left in storage is filtered, not trusted.
  const recent = Array.isArray(stored)
    ? stored.filter((v): v is string => typeof v === "string")
    : EMPTY;
  const remember = (value: string | null | undefined) => {
    if (!value?.trim()) return;
    setStored((prev) => pushRecent(Array.isArray(prev) ? prev : [], value));
  };
  return [recent, remember];
}

type Group = "recent" | "others" | "matches";

export interface SuggestInputProps
  extends Omit<ComponentProps<"input">, "value" | "onChange" | "defaultValue" | "type"> {
  /** The text in the field. Always free: a suggestion is offered, never forced. */
  value: string;
  onValueChange: (value: string) => void;
  /**
   * The data source: the values this field may suggest, with a use count and last use when known.
   * Called with the current (trimmed) query, so a source may narrow a large list itself; the field
   * ranks whatever comes back (`lib/utils/suggest.ts`).
   */
  source: (query: string) => readonly SuggestCandidate[] | undefined;
  /**
   * The field's name in the viewer's recent-values store (e.g. `"asset.company"`), shared with
   * {@link useRecentValues} — the form calls its `remember` after a successful save.
   */
  recentKey: string;
}

/**
 * Smart entry (#1470, Purchases UX proposal §4): a free-text input that suggests values entered
 * before, so the operator types less and spellings stay consistent.
 *
 * - **Focused and empty:** the viewer's recent values, then the most used ones.
 * - **Typing:** the closest matches — same value, starts with, a word starts with, contains, close
 *   spelling — then by use and recency. When the best match completes what was typed it is
 *   highlighted, so Tab or Enter takes it.
 * - **Keyboard:** ↓ opens the list; ↑/↓ move; Enter or Tab takes the highlighted value; Esc closes the
 *   list and keeps the text; Ctrl/Cmd+Enter keeps the text as typed.
 * - **Near-duplicate hint:** when the text is another spelling of an existing value ("DELL" for
 *   "Dell"), a non-blocking hint offers the existing one. Nothing is replaced without the operator's
 *   action, and a new value always saves as typed.
 *
 * Accessibility: the input is an ARIA 1.2 `combobox` (`aria-autocomplete="list"`) that owns a
 * `listbox` through `aria-controls` and tracks the highlighted `option` with `aria-activedescendant`;
 * focus never leaves the input. Label it with `FieldLabel htmlFor={id}` like any input. The list is a
 * Popover anchored to the input, so a scrolling dialog does not clip it and Esc closes the list
 * before it reaches an enclosing dialog.
 */
export function SuggestInput({
  value,
  onValueChange,
  source,
  recentKey,
  id,
  onFocus,
  onBlur,
  onKeyDown,
  disabled,
  "aria-describedby": describedBy,
  ...inputProps
}: SuggestInputProps) {
  const t = useTranslations("common.suggest");
  const { relative } = useFormatters();
  const [recent] = useRecentValues(recentKey);
  const [wantOpen, setWantOpen] = useState(false);
  // null = automatic: the best match is highlighted only when it completes what was typed.
  const [highlight, setHighlight] = useState<number | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const baseId = `${id ?? generatedId}-suggest`;
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const optionId = (index: number) => `${listId}-${index}`;

  const query = value.trim();
  const candidates = source(query) ?? [];
  const hasCounts = candidates.some((c) => c.count !== undefined);

  let options: (SuggestCandidate & { group: Group })[];
  let completes = false;
  if (query === "") {
    const initial = initialSuggestions(candidates, recent);
    options = [
      ...initial.recent.map((c) => ({ ...c, group: "recent" as const })),
      ...initial.others.map((c) => ({ ...c, group: "others" as const })),
    ];
  } else {
    const ranked = rankSuggestions(candidates, query, { recent });
    // The exact text already typed is not worth suggesting.
    options = ranked
      .filter((c) => c.value !== query)
      .map((c) => ({ ...c, group: "matches" as const }));
    completes = ranked[0] !== undefined && ranked[0].value !== query && ranked[0].tier <= 1;
  }

  const open = wantOpen && !disabled && options.length > 0;
  const active =
    highlight !== null ? Math.min(highlight, options.length - 1) : completes ? 0 : -1;
  const nearDuplicate = open ? null : findNearDuplicate(value, candidates);

  function take(next: string) {
    onValueChange(next);
    setWantOpen(false);
    setHighlight(null);
  }

  // Keep the highlighted row in view while moving with the keyboard.
  useEffect(() => {
    if (open && active >= 0) {
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, active, listId]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const action = suggestKeyAction(event.key, {
      open,
      active,
      count: options.length,
      shiftKey: event.shiftKey,
      modKey: event.ctrlKey || event.metaKey,
    });
    switch (action.type) {
      case "open":
      case "move":
        event.preventDefault();
        setWantOpen(true);
        setHighlight(action.highlight);
        return;
      case "take":
        if (action.preventDefault) event.preventDefault();
        take(options[action.index]!.value);
        return;
      case "keep":
        if (action.preventDefault) event.preventDefault();
        setWantOpen(false);
        setHighlight(null);
        return;
    }
  }

  const groups = (["recent", "others", "matches"] as const)
    .map((group) => ({
      group,
      items: options
        .map((option, index) => ({ option, index }))
        .filter(({ option }) => option.group === group),
    }))
    .filter(({ items }) => items.length > 0);
  const groupLabel = (group: Group) =>
    group === "recent"
      ? t("recent")
      : group === "matches"
        ? t("matches")
        : hasCounts
          ? t("mostUsed")
          : t("others");

  function meta(option: SuggestCandidate): string {
    const parts: string[] = [];
    if (option.count !== undefined) parts.push(t("uses", { count: option.count }));
    const at = option.lastUsedAt == null ? null : new Date(option.lastUsedAt);
    if (at && Number.isFinite(at.getTime())) parts.push(relative(at.toISOString()));
    return parts.join(" · ");
  }

  return (
    <div className="flex w-full flex-col">
      <Popover open={open} onOpenChange={(next) => !next && setWantOpen(false)}>
        <PopoverAnchor asChild>
          <div ref={anchorRef}>
            <Input
              {...inputProps}
              id={id}
              type="text"
              role="combobox"
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
              aria-describedby={
                [describedBy, nearDuplicate ? hintId : undefined].filter(Boolean).join(" ") ||
                undefined
              }
              disabled={disabled}
              value={value}
              onChange={(event) => {
                onValueChange(event.target.value);
                setHighlight(null);
                setWantOpen(true);
              }}
              onFocus={(event) => {
                onFocus?.(event);
                setWantOpen(true);
              }}
              onClick={() => setWantOpen(true)}
              onBlur={(event) => {
                onBlur?.(event);
                setWantOpen(false);
                setHighlight(null);
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          // The listbox inside is the popup the combobox controls; this wrapper adds no role.
          role="presentation"
          className="w-(--radix-popover-trigger-width) min-w-56 p-1"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // A click back into the input is not "outside".
            if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
        >
          <div
            id={listId}
            role="listbox"
            aria-label={t("listLabel")}
            className="max-h-64 overflow-y-auto"
          >
            {groups.map(({ group, items }) => (
              <div key={group} role="group" aria-label={groupLabel(group)}>
                <div
                  aria-hidden
                  className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground"
                >
                  {groupLabel(group)}
                </div>
                {items.map(({ option, index }) => {
                  const detail = meta(option);
                  return (
                    <div
                      key={option.value}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === active}
                      className={cn(
                        "flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm",
                        index === active && "bg-accent text-accent-foreground",
                      )}
                      // Keep focus in the input: the list is driven from there.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => take(option.value)}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.value}</span>
                      {detail ? (
                        <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {/* Always rendered, so the hint is announced when it appears. */}
      <div id={hintId} aria-live="polite">
        {nearDuplicate ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>
              {t("nearDuplicate", { value: nearDuplicate.value })}
              {nearDuplicate.count !== undefined
                ? ` ${t("usesSentence", { count: nearDuplicate.count })}`
                : null}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={() => onValueChange(nearDuplicate.value)}
            >
              {t("useExisting", { value: nearDuplicate.value })}
            </Button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
