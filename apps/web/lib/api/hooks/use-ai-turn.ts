"use client";

import type {
  AiApprovalDecisionValue,
  AiPageContext,
  AiRunError,
  AiRunEvent,
} from "@lazyit/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { isOutsideAssistant, planEffects, planSnapshotEffects } from "@/lib/ai/effects";
import {
  decisionErrorKind,
  decisionNeedsRefresh,
  refusalOf,
  sendErrorCode,
  type DecisionErrorKind,
} from "@/lib/ai/error-kinds";
import { eventSeq, isTerminalRunStatus, parseRunEvent, streamClosesOn } from "@/lib/ai/run-events";
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from "@/lib/ai/stream-reducer";
import { hasUnsavedChanges } from "@/lib/ai/unsaved-changes";
import { ApiError } from "../client";
import {
  cancelAiRun,
  decideAiToolCall,
  getAiConversation,
  sendAiMessage,
  streamAiRunEvents,
} from "../endpoints/ai";
import {
  aiConversationKeys,
  useAiConversation,
  useCreateAiConversation,
} from "./use-ai-conversations";
import { aiKeys } from "./use-ai-status";

/**
 * The chat's turn engine (frontend.md §5.2 "Turn lifecycle", synthesis §4.6 / R2): send → `202 { runId }`
 * → follow `GET /ai/runs/:id/events` with `Last-Event-ID` reconnects (snapshot fallback) → the pure
 * reducer builds the transcript → the effects plan refreshes the page around the chat. Owns the
 * `AbortController` of the one stream it follows.
 *
 * The panel remounts when it is closed and reopened; the conversation it showed is remembered for the
 * tab, and reopening re-reads it and re-subscribes to its active run (the server answers `run.snapshot`).
 */

/** Consecutive failed connections before the chat says "connection lost" and falls back to a re-read. */
const MAX_RECONNECTS = 5;

let rememberedConversationId: string | null = null;

export type StreamConnection = "idle" | "open" | "reconnecting" | "lost";

export type DecisionResult = { ok: true } | { ok: false; error: DecisionErrorKind };

function backoffMs(failures: number): number {
  return Math.min(1000 * 2 ** (failures - 1), 8000);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function noticeFrom(error: unknown): AiRunError {
  const refusal = refusalOf(error);
  return {
    code: sendErrorCode(error),
    message: refusal?.message ?? "",
    ...(refusal?.retryAfterSec != null ? { retryAfterSec: refusal.retryAfterSec } : {}),
    ...(refusal?.requestId ? { requestId: refusal.requestId } : {}),
  };
}

export function useAiTurn() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [conversationId, setConversationId] = useState<string | null>(rememberedConversationId);
  const [state, dispatch] = useReducer(chatReducer, conversationId, initialChatState);
  const [connection, setConnection] = useState<StreamConnection>("idle");
  const detail = useAiConversation(conversationId);
  const createConversation = useCreateAiConversation();

  const send = useMutation({
    mutationFn: (vars: { id: string; text: string; context?: AiPageContext }) =>
      sendAiMessage(vars.id, {
        text: vars.text,
        ...(vars.context ? { context: vars.context } : {}),
      }),
  });
  const cancel = useMutation({ mutationFn: (runId: string) => cancelAiRun(runId) });
  const decide = useMutation({
    mutationFn: (vars: {
      runId: string;
      toolCallId: string;
      decision: AiApprovalDecisionValue;
      password?: string;
    }) =>
      decideAiToolCall(vars.runId, vars.toolCallId, {
        decision: vars.decision,
        ...(vars.password ? { password: vars.password } : {}),
      }),
  });

  const stateRef = useRef<ChatState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const followRef = useRef<AbortController | null>(null);
  const appliedRef = useRef(new Set<string>());
  const hydratedFor = useRef<string | null>(null);

  useEffect(() => {
    rememberedConversationId = conversationId;
  }, [conversationId]);

  const invalidateOutside = useCallback(() => {
    void queryClient.invalidateQueries({ predicate: isOutsideAssistant });
  }, [queryClient]);

  const applyEffects = useCallback(
    (event: AiRunEvent) => {
      if (event.type === "run.snapshot") {
        const plan = planSnapshotEffects(event, appliedRef.current);
        plan.callIds.forEach((id) => appliedRef.current.add(id));
        if (plan.invalidate) invalidateOutside();
        return;
      }
      if (event.type === "run.finished") {
        void queryClient.invalidateQueries({ queryKey: aiConversationKeys.list() });
        const code = event.error?.code;
        if (code === "AI_DISABLED" || code === "FORBIDDEN") {
          void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
        }
        return;
      }
      if (event.type !== "tool.result") return;
      const plan = planEffects(event, {
        live: true,
        unsaved: hasUnsavedChanges(),
        alreadyApplied: appliedRef.current.has(event.toolCallId),
      });
      appliedRef.current.add(event.toolCallId);
      if (plan.invalidate) invalidateOutside();
      if (plan.navigateTo) {
        router.push(plan.navigateTo);
        dispatch({ type: "navigated", toolCallId: event.toolCallId });
      }
    },
    [invalidateOutside, queryClient, router],
  );

  /** Re-reads the conversation (the fallback when the stream cannot be resumed). */
  const rehydrate = useCallback(
    async (id: string) => {
      try {
        const fresh = await queryClient.fetchQuery({
          queryKey: aiConversationKeys.detail(id),
          queryFn: () => getAiConversation(id),
          staleTime: 0,
        });
        dispatch({ type: "hydrate", detail: fresh });
      } catch {
        // The notice already on screen says the connection was lost.
      }
    },
    [queryClient],
  );

  /**
   * Follows a run's events until the stream closes as designed (awaiting approval or finished). A drop
   * reconnects with `Last-Event-ID` (the server replays or sends a snapshot); `null` asks for a snapshot.
   */
  const follow = useCallback(
    async (runId: string, fromEventId: string | null) => {
      followRef.current?.abort();
      const controller = new AbortController();
      followRef.current = controller;
      const { signal } = controller;
      let lastEventId = fromEventId;
      let failures = 0;
      let status: string | null = null;

      while (!signal.aborted) {
        try {
          const stream = await streamAiRunEvents(runId, { lastEventId, signal });
          failures = 0;
          setConnection("open");
          for await (const message of stream) {
            if (signal.aborted) break;
            const event = parseRunEvent(message);
            if (!event) continue;
            const id = eventSeq(message.lastEventId, runId) !== null ? message.lastEventId : null;
            if (id) lastEventId = id;
            dispatch({ type: "event", runId, eventId: id, event });
            applyEffects(event);
            if (
              event.type === "run.status" ||
              event.type === "run.snapshot" ||
              event.type === "run.finished"
            ) {
              status = event.status;
            }
          }
          if (signal.aborted || streamClosesOn(status)) break;
          // The server closed early (its maximum stream lifetime): resume where we are.
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            dispatch({ type: "notice", error: noticeFrom(error) });
            break;
          }
          failures += 1;
          if (failures > MAX_RECONNECTS) {
            setConnection("lost");
            dispatch({
              type: "notice",
              error: { code: "NETWORK", message: "" },
            });
            const convo = stateRef.current.conversationId;
            if (convo) await rehydrate(convo);
            if (followRef.current === controller) followRef.current = null;
            return;
          }
          setConnection("reconnecting");
          await sleep(backoffMs(failures), signal);
        }
      }
      if (followRef.current === controller) {
        followRef.current = null;
        setConnection("idle");
      }
      if (isTerminalRunStatus(status)) {
        void queryClient.invalidateQueries({ queryKey: aiConversationKeys.list() });
      }
    },
    [applyEffects, queryClient, rehydrate],
  );

  // Hydrate once per opened conversation, then re-subscribe to its active run (snapshot first).
  useEffect(() => {
    const data = detail.data;
    if (!data || hydratedFor.current === data.id) return;
    hydratedFor.current = data.id;
    dispatch({ type: "hydrate", detail: data });
    const runId = data.activeRunId;
    // Subscribing starts network work that reports back through state: begin it after this commit.
    if (runId) queueMicrotask(() => void follow(runId, null));
  }, [detail.data, follow]);

  // Stop following when the panel unmounts; the run itself continues on the server.
  useEffect(() => () => followRef.current?.abort(), []);

  const resetTo = useCallback(
    (id: string | null) => {
      followRef.current?.abort();
      followRef.current = null;
      appliedRef.current = new Set();
      hydratedFor.current = null;
      setConnection("idle");
      if (id) queryClient.removeQueries({ queryKey: aiConversationKeys.detail(id) });
      dispatch({ type: "reset", conversationId: id });
      setConversationId(id);
    },
    [queryClient],
  );

  /** Opens a conversation from the history. */
  const openConversation = useCallback((id: string) => resetTo(id), [resetTo]);

  /** Starts over with an empty chat (the conversation is created on the first message). */
  const newChat = useCallback(() => resetTo(null), [resetTo]);

  /** Sends a message. Resolves `false` when it was refused, so the composer keeps the text. */
  const sendMessage = useCallback(
    async (text: string, context?: AiPageContext): Promise<boolean> => {
      const localId = `local:${Date.now()}`;
      dispatch({ type: "userMessage", localId, text, createdAt: new Date().toISOString() });
      let id = stateRef.current.conversationId ?? conversationId;
      try {
        if (!id) {
          const created = await createConversation.mutateAsync();
          id = created.id;
          // The new conversation's transcript is the one being built here: never hydrate over it.
          hydratedFor.current = id;
          dispatch({ type: "bindConversation", conversationId: id });
          setConversationId(id);
        }
        const accepted = await send.mutateAsync({ id, text, ...(context ? { context } : {}) });
        dispatch({ type: "runStarted", runId: accepted.runId, status: accepted.status });
        void queryClient.invalidateQueries({ queryKey: aiConversationKeys.list() });
        void follow(accepted.runId, null);
        return true;
      } catch (error) {
        dispatch({ type: "dropLocal", localId });
        const notice = noticeFrom(error);
        dispatch({ type: "notice", error: notice });
        if (notice.code === "AI_DISABLED" || notice.code === "FORBIDDEN") {
          void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
        }
        if (id && (notice.code === "RUN_IN_PROGRESS" || notice.code === "CONVERSATION_READ_ONLY")) {
          // Another window is answering, or the chat is closed: re-read it and follow what is live.
          hydratedFor.current = null;
          await queryClient.invalidateQueries({ queryKey: aiConversationKeys.detail(id) });
        }
        return false;
      }
    },
    [conversationId, createConversation, follow, queryClient, send],
  );

  /** Stops the run. The stream keeps going until the server reports it cancelled (partial output kept). */
  const stop = useCallback(async () => {
    const run = stateRef.current.run;
    if (!run) return;
    try {
      const accepted = await cancel.mutateAsync(run.id);
      dispatch({ type: "runStarted", runId: run.id, status: accepted.status });
      if (!followRef.current) void follow(run.id, run.lastEventId);
    } catch (error) {
      dispatch({ type: "notice", error: noticeFrom(error) });
    }
  }, [cancel, follow]);

  /** Approves or rejects a pending write; on success re-subscribes to the run. */
  const decideCall = useCallback(
    async (
      toolCallId: string,
      decision: AiApprovalDecisionValue,
      password?: string,
    ): Promise<DecisionResult> => {
      const run = stateRef.current.run;
      if (!run) return { ok: false, error: { kind: "notAwaiting" } };
      try {
        const accepted = await decide.mutateAsync({
          runId: run.id,
          toolCallId,
          decision,
          ...(password ? { password } : {}),
        });
        dispatch({ type: "runStarted", runId: run.id, status: accepted.status });
        void follow(run.id, stateRef.current.run?.lastEventId ?? run.lastEventId);
        return { ok: true };
      } catch (error) {
        const kind = decisionErrorKind(error);
        if (kind.kind === "aiDisabled") {
          void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
        }
        // The card changed or was decided elsewhere: a fresh snapshot re-renders it from the server.
        if (decisionNeedsRefresh(kind)) void follow(run.id, null);
        return { ok: false, error: kind };
      }
    },
    [decide, follow, queryClient],
  );

  /** Reconnects after "connection lost". */
  const reconnect = useCallback(() => {
    const run = stateRef.current.run;
    if (run) void follow(run.id, run.lastEventId);
  }, [follow]);

  const dismissNotice = useCallback(() => dispatch({ type: "notice", error: null }), []);

  return {
    conversationId,
    state,
    connection,
    loading: conversationId !== null && detail.isPending && state.messages.length === 0,
    loadError: detail.error,
    readOnly: detail.data?.readOnly === true || state.runError?.code === "CONVERSATION_READ_ONLY",
    sending: createConversation.isPending || send.isPending,
    stopping: cancel.isPending,
    openConversation,
    newChat,
    sendMessage,
    stop,
    decide: decideCall,
    reconnect,
    dismissNotice,
  };
}

export type AiTurn = ReturnType<typeof useAiTurn>;
