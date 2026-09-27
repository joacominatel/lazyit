"use client";

import type { AiMessagePart } from "@lazyit/shared";
import {
  ChatBubbleLeftEllipsisIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError } from "@/lib/api/client";
import {
  hasAutoApproveConsent,
  rememberAutoApproveConsent,
  settingsErrorKey,
  settingsPatch,
  shortModelName,
  viewOfDraft,
  viewOfSettings,
  type ChatSettingsDraft,
} from "@/lib/ai/chat-settings";
import { presentPreview } from "@/lib/ai/preview";
import type { SentenceRenderer } from "@/lib/ai/sentences";
import { BUILTIN_SLASH_COMMANDS, type SlashCommand, type SlashCommandContext } from "@/lib/ai/slash-commands";
import {
  isAwaitingApproval,
  isAwaitingInput,
  isRunActive,
  pendingInput,
  type ChatMessage,
} from "@/lib/ai/stream-reducer";
import { plainText } from "@/lib/ai/untrusted-text";
import { conversationToMarkdown } from "@/lib/ai/transcript-markdown";
import { aiConversationKeys, useUpdateAiConversation } from "@/lib/api/hooks/use-ai-conversations";
import { useAiModels } from "@/lib/api/hooks/use-ai-models";
import { aiKeys } from "@/lib/api/hooks/use-ai-status";
import { useAiTurn } from "@/lib/api/hooks/use-ai-turn";
import { AiAutoApproveConsent } from "./ai-auto-approve-consent";
import { AiChatHelp } from "./ai-chat-help";
import { AiChatSettings } from "./ai-chat-settings";
import { AiComposer } from "./ai-composer";
import { AiConversationHistory } from "./ai-conversation-history";
import { AiBackIcon, AiHistoryIcon, AiNewChatIcon } from "./ai-icons";
import { PENDING_INPUT_ATTR } from "./ai-input-card";
import { useToolDisplayName } from "./ai-labels";
import { AiMessage } from "./ai-message";
import { AiRunNotice } from "./ai-run-notice";
import { useAiSentences } from "./use-ai-sentences";
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
  sentences: SentenceRenderer,
): string | null {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "approval" && p.outcome === null) {
        return presentPreview(p.request.preview, sentences).action?.text ?? toolName(p.request.preview.toolName);
      }
    }
  }
  return null;
}

/** Scrolls the pending input form into view and moves focus into it (its first control, else the card). */
function focusPendingInput(log: HTMLElement | null) {
  const card = log?.querySelector<HTMLElement>(`[${PENDING_INPUT_ATTR}]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  const control = card.querySelector<HTMLElement>("form input, form textarea, form button");
  (control ?? card).focus();
}

/** `window.localStorage`, or undefined where reading it throws (blocked site data, some private modes). */
function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
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
  const sentences = useAiSentences();
  const transcriptLabels = useTranscriptLabels();
  const [view, setView] = useState<"chat" | "history">("chat");
  const [helpOpen, setHelpOpen] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const catalogQuery = useAiModels();
  const catalog = catalogQuery.data;
  const updateSettings = useUpdateAiConversation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);

  // The chat's settings (#1373, #1376): the server's for a created chat, the local draft for a new one.
  // A chat with messages has a run, so its model is pinned even if the copy of its settings is older.
  const started = state.messages.length > 0 || state.run !== null;
  const settingsView = turn.settings
    ? viewOfSettings(turn.settings, { started })
    : { ...viewOfDraft(turn.draft, catalog), locked: turn.conversationId !== null && started };

  /** Applies a settings change: to the draft of a new chat, else with PATCH. False when refused. */
  async function applySettings(change: Partial<ChatSettingsDraft>): Promise<boolean> {
    const id = turn.conversationId;
    if (id === null) {
      turn.setDraft((draft) => ({ ...draft, ...change }));
      return true;
    }
    const patch = settingsPatch(settingsView, change, catalog?.defaultModel ?? null);
    if (patch === null) return true;
    try {
      await updateSettings.mutateAsync({ id, patch });
      return true;
    } catch (error) {
      const key = settingsErrorKey(error);
      toast.error(t(`settings.errors.${key}`));
      if (key === "aiDisabled") void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
      if (key === "readOnly") void queryClient.invalidateQueries({ queryKey: aiConversationKeys.detail(id) });
      return false;
    }
  }

  async function setAutoApprove(on: boolean) {
    if (await applySettings({ autoApprove: on })) {
      toast(on ? t("settings.auto.turnedOn") : t("settings.auto.turnedOff"));
    }
  }

  /** The switch or `/auto`: turning it on asks for consent the first time in this browser. */
  function requestAutoApprove(on: boolean) {
    if (on === settingsView.autoApprove) {
      toast(on ? t("settings.auto.alreadyOn") : t("settings.auto.alreadyOff"));
      return;
    }
    if (on && !hasAutoApproveConsent(browserStorage())) {
      setSettingsOpen(false);
      setConsentOpen(true);
      return;
    }
    void setAutoApprove(on);
  }

  async function chooseModel(id: string | null) {
    if (id === null) {
      setSettingsOpen(true);
      return;
    }
    if (settingsView.locked) {
      toast.error(t("settings.errors.locked"));
      return;
    }
    if (await applySettings({ model: id })) toast(t("settings.model.set", { model: shortModelName(id) }));
  }

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
    chooseModel: (id) => void chooseModel(id),
    setAutoApprove: (on) => requestAutoApprove(on ?? !settingsView.autoApprove),
  };
  const runCommand = (command: SlashCommand, argument: string | null) =>
    void command.run(commandContext, argument);

  const tools = useMemo(() => {
    const map = new Map<string, ToolPart>();
    for (const m of state.messages) for (const p of m.parts) if (p.type === "tool") map.set(p.toolCallId, p);
    return map;
  }, [state.messages]);

  const running = isRunActive(state);
  const awaiting = isAwaitingApproval(state);
  const awaitingInput = isAwaitingInput(state);
  const inputRequest = awaitingInput ? pendingInput(state.messages) : null;
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
  const action = runStatus === "AWAITING_APPROVAL" ? pendingAction(state.messages, toolName, sentences) : null;
  const inputTitle = inputRequest ? plainText(inputRequest.request.form.title) : null;
  const announcement =
    runStatus === "SUCCEEDED"
      ? t("live.replied")
      : action
        ? t("live.approvalNeeded", { action })
        : inputTitle
          ? t("live.inputNeeded", { title: inputTitle })
          : "";

  const notFound = turn.loadError instanceof ApiError && turn.loadError.status === 404;
  const retryText = lastUserText(state.messages);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {view === "history" ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setView("chat")}>
            <AiBackIcon />
            {t("panel.backToChat")}
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setView("history")}>
            <AiHistoryIcon />
            {t("panel.history")}
          </Button>
        )}
        {settingsView.autoApprove && (
          <StatusBadge tone="warning" className="ml-auto" title={t("settings.auto.badgeTitle")}>
            {t("settings.auto.badge")}
            <span className="sr-only">: {t("settings.auto.badgeTitle")}</span>
          </StatusBadge>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={settingsView.autoApprove ? undefined : "ml-auto"}
          onClick={startNewChat}
        >
          <AiNewChatIcon />
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
                onAnswerInput={turn.answerInput}
                onInputExpired={turn.inputExpired}
              />
            ))}

            {thinking && (
              <p className="animate-pulse text-xs text-muted-foreground motion-reduce:animate-none">
                {t("message.thinking")}
              </p>
            )}
            {awaiting && <p className="text-xs text-muted-foreground">{t("message.awaitingApproval")}</p>}
            {awaitingInput && <p className="text-xs text-muted-foreground">{t("message.awaitingInput")}</p>}
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
              blockedByInput={awaitingInput}
              inputBanner={
                <div className="mb-2 flex items-center gap-2 rounded-sm border border-border bg-muted/50 px-2 py-1.5 text-xs">
                  <ChatBubbleLeftEllipsisIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {inputTitle ? t("composer.inputWaiting", { title: inputTitle }) : t("composer.inputWaitingGeneric")}
                  </span>
                  {inputRequest && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => focusPendingInput(logRef.current)}
                    >
                      {t("composer.goToForm")}
                    </Button>
                  )}
                </div>
              }
              onSend={turn.sendMessage}
              onStop={() => void turn.stop()}
              commands={BUILTIN_SLASH_COMMANDS}
              onCommand={runCommand}
              autoApprove={settingsView.autoApprove}
              toolbar={
                <AiChatSettings
                  catalog={catalog}
                  catalogLoading={catalogQuery.isPending}
                  view={settingsView}
                  saving={updateSettings.isPending}
                  open={settingsOpen}
                  onOpenChange={setSettingsOpen}
                  onChange={(change) => void applySettings(change)}
                  onAutoApproveChange={requestAutoApprove}
                />
              }
            />
          )}
          <AiAutoApproveConsent
            open={consentOpen}
            onCancel={() => setConsentOpen(false)}
            onConfirm={() => {
              rememberAutoApproveConsent(browserStorage());
              setConsentOpen(false);
              void setAutoApprove(true);
            }}
          />
        </>
      )}
    </div>
  );
}
