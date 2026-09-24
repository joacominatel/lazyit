"use client";

import type { AiMessagePart } from "@lazyit/shared";
import { ArrowLeftIcon, ClockIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { presentPreview } from "@/lib/ai/preview";
import { BUILTIN_SLASH_COMMANDS, type SlashCommand, type SlashCommandContext } from "@/lib/ai/slash-commands";
import { isAwaitingApproval, isRunActive, type ChatMessage } from "@/lib/ai/stream-reducer";
import { conversationToMarkdown } from "@/lib/ai/transcript-markdown";
import { useAiTurn } from "@/lib/api/hooks/use-ai-turn";
import { AiChatHelp } from "./ai-chat-help";
import { AiComposer } from "./ai-composer";
import { AiConversationHistory } from "./ai-conversation-history";
import { useToolDisplayName } from "./ai-labels";
import { AiMessage } from "./ai-message";
import { AiRunNotice } from "./ai-run-notice";
import { useTranscriptLabels } from "./use-transcript-labels";

type ToolPart = Extract<AiMessagePart, { type: "tool" }>;

function lastUserText(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
    if (text) return text;
  }
  return null;
}

/** The first pending approval's action sentence (else its tool's name), for the live announcement. */
function pendingAction(
  messages: readonly ChatMessage[],
  toolName: (name: string) => string,
): string | null {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "approval" && p.outcome === null) {
        return presentPreview(p.request.preview).action?.text ?? toolName(p.request.preview.toolName);
      }
    }
  }
  return null;
}

/** Writes text to the clipboard; false when the browser refuses (insecure context, denied permission). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The AI assistant panel content (frontend.md §5.2): the chat — history list, message log, approval
 * cards, composer — rendered inside W1-D's panel slot, which owns the placement, the title and Close.
 * Loaded on first open only (`next/dynamic` in the slot).
 */
export function AiChatPanel() {
  const t = useTranslations("ai");
  const turn = useAiTurn();
  const { state } = turn;
  const toolName = useToolDisplayName();
  const transcriptLabels = useTranscriptLabels();
  const [view, setView] = useState<"chat" | "history">("chat");
  const [helpOpen, setHelpOpen] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  function startNewChat() {
    turn.newChat();
    setHelpOpen(false);
    setView("chat");
  }

  // Slash commands (#1372): run here, in the browser — never sent to the model.
  const commandContext: SlashCommandContext = {
    copyConversation: async () => {
      const markdown = conversationToMarkdown(state.messages, transcriptLabels);
      if (markdown === "") {
        toast(t("commands.copyEmpty"));
        return;
      }
      if (await writeClipboard(markdown)) toast.success(t("commands.copied"));
      else toast.error(t("commands.copyFailed"));
    },
    newChat: startNewChat,
    showHelp: () => setHelpOpen(true),
  };
  const runCommand = (command: SlashCommand) => void command.run(commandContext);

  const tools = useMemo(() => {
    const map = new Map<string, ToolPart>();
    for (const m of state.messages) for (const p of m.parts) if (p.type === "tool") map.set(p.toolCallId, p);
    return map;
  }, [state.messages]);

  const running = isRunActive(state);
  const awaiting = isAwaitingApproval(state);
  const lastMessage = state.messages[state.messages.length - 1];
  const thinking = running && !(lastMessage?.role === "assistant" && lastMessage.streaming);

  // Keep the newest content in view while the log grows.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, thinking, helpOpen]);

  // Completion-only announcements (deltas are never announced): the live region's text changes only
  // when the run finishes or starts waiting for a decision.
  const runStatus = state.run?.status;
  const action = runStatus === "AWAITING_APPROVAL" ? pendingAction(state.messages, toolName) : null;
  const announcement =
    runStatus === "SUCCEEDED"
      ? t("live.replied")
      : action
        ? t("live.approvalNeeded", { action })
        : "";

  const notFound = turn.loadError instanceof ApiError && turn.loadError.status === 404;
  const retryText = lastUserText(state.messages);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {view === "history" ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setView("chat")}>
            <ArrowLeftIcon />
            {t("panel.backToChat")}
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setView("history")}>
            <ClockIcon />
            {t("panel.history")}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={startNewChat}
        >
          <PlusIcon />
          {t("panel.newChat")}
        </Button>
      </div>

      {view === "history" ? (
        <AiConversationHistory
          currentId={turn.conversationId}
          onOpen={(id) => {
            turn.openConversation(id);
            setView("chat");
          }}
          onDeleted={(id) => {
            if (id === turn.conversationId) turn.newChat();
          }}
        />
      ) : (
        <>
          <div
            ref={logRef}
            role="log"
            aria-busy={running}
            aria-label={t("panel.title")}
            // `relative` makes the log the containing block of its visually hidden (absolute) labels, so
            // the scroll box clips them: otherwise they escaped it and stretched the page below the app
            // shell (#1370).
            className="relative min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
          >
            {turn.loading && (
              <div className="space-y-2" aria-label={t("panel.loading")}>
                <Skeleton className="h-10 w-3/4" />
                <Skeleton className="ml-auto h-8 w-1/2" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}

            {turn.loadError && !turn.loading && state.messages.length === 0 && (
              <div role="alert" className="text-sm text-muted-foreground">
                <p>{notFound ? t("panel.conversationGone") : t("panel.loadError")}</p>
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={turn.newChat}>
                  {t("errors.newChat")}
                </Button>
              </div>
            )}

            {!turn.loading && !turn.loadError && state.messages.length === 0 && (
              <div className="py-6 text-center">
                <p className="text-sm font-medium">{t("message.emptyTitle")}</p>
                <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">{t("message.emptyBody")}</p>
                <ul className="mt-4 space-y-1.5">
                  {(["one", "two", "three"] as const).map((key) => (
                    <li key={key}>
                      <button
                        type="button"
                        disabled={turn.sending}
                        className="min-h-9 rounded-sm border border-border px-3 text-xs hover:bg-muted"
                        onClick={() => void turn.sendMessage(t(`message.examples.${key}`))}
                      >
                        {t(`message.examples.${key}`)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {state.messages.map((message) => (
              <AiMessage
                key={message.id}
                message={message}
                tools={tools}
                navigated={state.navigated}
                onDecide={turn.decide}
              />
            ))}

            {thinking && (
              <p className="animate-pulse text-xs text-muted-foreground motion-reduce:animate-none">
                {t("message.thinking")}
              </p>
            )}
            {awaiting && <p className="text-xs text-muted-foreground">{t("message.awaitingApproval")}</p>}
            {turn.connection === "reconnecting" && (
              <p role="status" className="text-xs text-muted-foreground">
                {t("connection.reconnecting")}
              </p>
            )}

            {helpOpen && (
              <AiChatHelp commands={BUILTIN_SLASH_COMMANDS} onClose={() => setHelpOpen(false)} />
            )}

            {state.runError && (
              <AiRunNotice
                error={state.runError}
                onRetry={retryText ? () => void turn.sendMessage(retryText) : undefined}
                onNewChat={turn.newChat}
                onReconnect={turn.reconnect}
                onDismiss={turn.dismissNotice}
              />
            )}
          </div>

          <div className="sr-only" aria-live="polite">
            {announcement}
          </div>

          {turn.readOnly ? (
            <div className="shrink-0 border-t border-border p-3 text-xs">
              <p className="font-medium">{t("composer.readOnlyTitle")}</p>
              <p className="mt-0.5 text-muted-foreground">{t("composer.readOnlyBody")}</p>
              <Button type="button" size="sm" className="mt-2" onClick={turn.newChat}>
                {t("errors.newChat")}
              </Button>
            </div>
          ) : (
            <AiComposer
              busy={turn.sending}
              running={running}
              stopping={turn.stopping}
              blockedByApproval={awaiting}
              onSend={turn.sendMessage}
              onStop={() => void turn.stop()}
              commands={BUILTIN_SLASH_COMMANDS}
              onCommand={runCommand}
            />
          )}
        </>
      )}
    </div>
  );
}
