"use client";

import type { AiPageContext } from "@lazyit/shared";
import { ArrowUpIcon, StopIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { routeContext } from "@/lib/ai/route-context";
import { AI_PROMPT_MAX_LENGTH } from "@lazyit/shared";
import { useEntityTypeLabel } from "./ai-labels";

/**
 * The message box (frontend.md §5.2 `Composer`, §5.4): Enter sends, Shift+Enter is a new line, an IME
 * composition never sends. The current page rides along as a visible, removable chip — only the route
 * and at most one entity ref, never page content (§11 item 7).
 */
export function AiComposer({
  busy,
  running,
  stopping,
  blockedByApproval,
  onSend,
  onStop,
}: {
  /** A send is in flight. */
  busy: boolean;
  /** A run is answering: the button is Stop. */
  running: boolean;
  stopping: boolean;
  /** The run waits for a decision on a card. */
  blockedByApproval: boolean;
  onSend: (text: string, context?: AiPageContext) => Promise<boolean>;
  onStop: () => void;
}) {
  const t = useTranslations("ai.composer");
  const tContext = useTranslations("ai.context");
  const entityLabel = useEntityTypeLabel();
  const pathname = usePathname();
  const [text, setText] = useState("");
  const [withContext, setWithContext] = useState(true);
  const inputId = useId();
  const hintId = useId();

  const context = routeContext(pathname);
  const disabled = busy || running || blockedByApproval;
  const trimmed = text.trim();

  async function submit() {
    if (disabled || trimmed.length === 0) return;
    const sent = await onSend(trimmed, withContext && context ? context : undefined);
    if (sent) setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
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
      className="shrink-0 border-t border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
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
                <XMarkIcon />
              </Button>
            </span>
          ) : (
            <Button type="button" variant="ghost" size="xs" onClick={() => setWithContext(true)}>
              {tContext("add")}
            </Button>
          )}
        </div>
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
          className="max-h-40 min-h-11 resize-none"
          onChange={(event) => setText(event.target.value)}
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
            <StopIcon />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon-lg"
            aria-label={t("send")}
            disabled={disabled || trimmed.length === 0}
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
      <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
        {blockedByApproval ? t("busyApproval") : t("hint")}
      </p>
    </form>
  );
}
