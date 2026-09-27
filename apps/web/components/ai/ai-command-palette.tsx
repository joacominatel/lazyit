"use client";

import { useTranslations } from "next-intl";
import type { SlashCommand } from "@/lib/ai/slash-commands";
import { cn } from "@/lib/utils";

/** The DOM id of a palette row, for the composer's `aria-activedescendant`. */
export function commandOptionId(listId: string, name: string): string {
  return `${listId}-${name}`;
}

/**
 * The slash-command palette (issue #1372): the rows the composer's `/query` matches, drawn above the
 * message box. It holds no state — the composer owns the query, the highlighted row and the keyboard
 * (focus stays in the textarea; the list is its `aria-controls` listbox). Rows are picked with a click;
 * `mousedown` is cancelled so the textarea keeps focus.
 */
export function AiCommandPalette<C>({
  listId,
  commands,
  highlighted,
  onPick,
  onHighlight,
}: {
  listId: string;
  commands: readonly SlashCommand<C>[];
  highlighted: number;
  onPick: (command: SlashCommand<C>) => void;
  onHighlight: (index: number) => void;
}) {
  const t = useTranslations("ai.commands");

  return (
    <div className="absolute inset-x-3 bottom-full z-10 mb-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      {commands.length === 0 ? (
        <p id={listId} role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul id={listId} role="listbox" aria-label={t("label")} className="max-h-60 overflow-y-auto py-1">
          {commands.map((command, index) => (
            <li
              key={command.name}
              id={commandOptionId(listId, command.name)}
              role="option"
              aria-selected={index === highlighted}
              className={cn(
                "flex min-h-9 cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm",
                index === highlighted && "bg-muted",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHighlight(index)}
              onClick={() => onPick(command)}
            >
              <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">/{command.name}</span>
              <span className="min-w-0">
                <span className="font-medium">{t(`${command.name}.label`)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t(`${command.name}.description`)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p aria-hidden className="border-t border-border px-3 py-1 text-xs text-muted-foreground">
        {t("keys")}
      </p>
    </div>
  );
}
