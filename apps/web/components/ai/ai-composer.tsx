"use client";

import type { AiPageContext } from "@lazyit/shared";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { routeContext } from "@/lib/ai/route-context";
import {
  filterSlashCommands,
  matchSlashCommand,
  moveHighlight,
  slashQuery,
  type SlashCommand,
} from "@/lib/ai/slash-commands";
import { AI_PROMPT_MAX_LENGTH } from "@lazyit/shared";
import { AiCommandPalette, commandOptionId } from "./ai-command-palette";
import { AiCloseIcon, AiSendIcon, AiStopIcon } from "./ai-icons";
import { useEntityTypeLabel } from "./ai-labels";

/**
 * The message box (frontend.md §5.2 `Composer`, §5.4): Enter sends, Shift+Enter is a new line, an IME
 * composition never sends. The current page rides along as a visible, removable chip — only the route
 * and at most one entity ref, never page content (§11 item 7).
 *
 * Slash commands (issue #1372): a `/` at the very start opens the command palette over the box, filtered
 * as you type; ↑/↓ move, Enter or Tab runs the highlighted command, Esc closes the palette. A message
 * that is exactly a command (`/copy`), or a command with an argument it understands (`/model gpt-4o`,
 * `/auto on`), runs it too. A command is run in the browser and NEVER sent to the
 * model. `commands` is the registry (`lib/ai/slash-commands.ts`); `toolbar` is a slot beside the hint for
 * per-chat controls (e.g. a model picker).
 */
export function AiComposer<C>({
  busy,
  running,
  stopping,
  blockedByApproval,
  blockedByInput = false,
  inputBanner,
  onSend,
  onStop,
  commands = [],
  onCommand,
  toolbar,
  autoApprove = false,
}: {
  /** A send is in flight. */
  busy: boolean;
  /** A run is answering: the button is Stop. */
  running: boolean;
  stopping: boolean;
  /** The run waits for a decision on a card. */
  blockedByApproval: boolean;
  /** The run waits for the user to answer an input form (#1388). */
  blockedByInput?: boolean;
  /** Shown above the box while an input form waits: what the assistant asked, and a way to reach it. */
  inputBanner?: ReactNode;
  onSend: (text: string, context?: AiPageContext) => Promise<boolean>;
  onStop: () => void;
  /** The slash commands the palette offers. */
  commands?: readonly SlashCommand<C>[];
  /** Runs a picked command with its argument, if typed (the composer clears itself first). */
  onCommand?: (command: SlashCommand<C>, argument: string | null) => void;
  /** Controls shown on the hint row, e.g. chat settings. */
  toolbar?: ReactNode;
  /** Auto-approve is on in this chat: the hint says basic changes apply without asking. */
  autoApprove?: boolean;
}) {
  const t = useTranslations("ai.composer");
  const tCommands = useTranslations("ai.commands");
  const tContext = useTranslations("ai.context");
  const entityLabel = useEntityTypeLabel();
  const pathname = usePathname();
  const [text, setText] = useState("");
  const [withContext, setWithContext] = useState(true);
  const [highlight, setHighlight] = useState(0);
  // The text the palette was closed for with Esc: it stays closed until the text changes.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  const listId = useId();

  const context = routeContext(pathname);
  const disabled = busy || running || blockedByApproval || blockedByInput;
  const trimmed = text.trim();

  const query = onCommand ? slashQuery(text) : null;
  const paletteOpen = query !== null && dismissedFor !== text;
  const matches = paletteOpen
    ? filterSlashCommands(commands, query, (c) => tCommands(`${c.name}.label`))
    : [];
  const active = matches.length === 0 ? -1 : Math.min(highlight, matches.length - 1);

  function runCommand(command: SlashCommand<C>, argument: string | null = null) {
    setText("");
    setHighlight(0);
    setDismissedFor(null);
    onCommand?.(command, argument);
  }

  async function submit() {
    // A message that names a command exactly runs it: a command never reaches the model.
    const matched = onCommand ? matchSlashCommand(commands, trimmed) : null;
    if (matched) {
      runCommand(matched.command, matched.argument);
      return;
    }
    if (disabled || trimmed.length === 0) return;
    const sent = await onSend(trimmed, withContext && context ? context : undefined);
    if (sent) setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (paletteOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight(moveHighlight(active, event.key === "ArrowDown" ? 1 : -1, matches.length));
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
        const command = active >= 0 ? matches[active] : undefined;
        if (command) {
          event.preventDefault();
          runCommand(command);
          return;
        }
      }
      if (event.key === "Escape") {
        // Closes the palette only — not the panel.
        event.preventDefault();
        event.stopPropagation();
        setDismissedFor(text);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  const contextName = context
    ? context.entity
      ? tContext("entity", { type: entityLabel(context.entity.type) })
      : tContext("route")
    : null;

  return (
    <form
      className="relative shrink-0 border-t border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {blockedByInput && inputBanner}
      {context && contextName && (
        <div className="mb-2 flex items-center gap-1">
          {withContext ? (
            <span className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-muted/50 py-0.5 pr-0.5 pl-2 text-xs">
              <span className="truncate">
                {tContext("label", { page: contextName })}{" "}
                <span className="font-mono text-muted-foreground">{context.route}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={tContext("remove")}
                onClick={() => setWithContext(false)}
              >
                <AiCloseIcon />
              </Button>
            </span>
          ) : (
            <Button type="button" variant="ghost" size="xs" onClick={() => setWithContext(true)}>
              {tContext("add")}
            </Button>
          )}
        </div>
      )}
      {paletteOpen && (
        <AiCommandPalette
          listId={listId}
          commands={matches}
          highlighted={active}
          onPick={(command) => runCommand(command)}
          onHighlight={setHighlight}
        />
      )}
      <label htmlFor={inputId} className="sr-only">
        {t("label")}
      </label>
      <div className="flex items-end gap-2">
        <Textarea
          id={inputId}
          autoFocus
          rows={2}
          value={text}
          maxLength={AI_PROMPT_MAX_LENGTH}
          placeholder={t("placeholder")}
          aria-describedby={hintId}
          aria-autocomplete={onCommand ? "list" : undefined}
          aria-controls={paletteOpen ? listId : undefined}
          aria-activedescendant={
            paletteOpen && active >= 0 ? commandOptionId(listId, matches[active]!.name) : undefined
          }
          className="max-h-40 min-h-11 resize-none"
          onChange={(event) => {
            setText(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            aria-label={stopping ? t("stopping") : t("stop")}
            disabled={stopping}
            onClick={onStop}
          >
            <AiStopIcon />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon-lg"
            aria-label={t("send")}
            disabled={disabled || trimmed.length === 0}
          >
            <AiSendIcon />
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        <p id={hintId} className="min-w-0 flex-1 text-xs text-muted-foreground">
          {blockedByApproval
            ? t("busyApproval")
            : blockedByInput
              ? t("busyInput")
              : autoApprove
                ? t("hintAuto")
                : t("hint")}
        </p>
        {toolbar && <div className="flex shrink-0 items-center gap-1">{toolbar}</div>}
      </div>
    </form>
  );
}
