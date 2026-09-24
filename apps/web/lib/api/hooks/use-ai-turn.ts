"use client";

import type {
  AiApprovalDecisionValue,
  AiInputAnswer,
  AiInputSubmission,
  AiPageContext,
  AiRunError,
  AiRunEvent,
} from "@lazyit/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  createBody,
  DEFAULT_CHAT_SETTINGS,
  type ChatSettingsDraft,
} from "@/lib/ai/chat-settings";
import { isOutsideAssistant, planEffects, planSnapshotEffects } from "@/lib/ai/effects";
import {
  decisionErrorKind,
  decisionNeedsRefresh,
  refusalOf,
  sendErrorCode,
  type DecisionErrorKind,
} from "@/lib/ai/error-kinds";
import {
  EXPIRY_RECHECK_MS,
  inputErrorKind,
  inputNeedsRefresh,
  type InputErrorKind,
} from "@/lib/ai/input-form";
import {
  afterStreamEnded,
  eventSeq,
  isTerminalRunStatus,
  parseRunEvent,
} from "@/lib/ai/run-events";
import {
  chatReducer,
  initialChatState,
  runStatusOfConversation,
  type ChatState,
} from "@/lib/ai/stream-reducer";
import { hasUnsavedChanges } from "@/lib/ai/unsaved-changes";
import { ApiError } from "../client";
import { handleAuthExpiry } from "../handle-auth-expiry";
import { handlePasswordChangeRequired } from "../handle-password-change-required";
import {
  answerAiInput,
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

export type InputResult = { ok: true } | { ok: false; error: InputErrorKind };

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
  // A chat not created yet keeps its settings here; they go with the create on the first message.
  const [draft, setDraft] = useState<ChatSettingsDraft>(DEFAULT_CHAT_SETTINGS);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
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
  // The approval decision is NOT a `useMutation`: its variables would carry the step-up password into
  // the mutation cache. It is called directly and its auth failures are routed by hand (see decideCall).

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
    (event: AiRunEvent, allowNavigate: boolean) => {
      if (event.type === "run.snapshot") {
        const plan = planSnapshotEffects(event, appliedRef.current);
        plan.callIds.forEach((id) => appliedRef.current.add(id));
        if (plan.invalidate) invalidateOutside();
        return;
      }
      if (event.type === "run.finished") {
        void queryClient.invalidateQueries({ queryKey: aiConversationKeys.list() });
        // The cached transcript is behind the stream now: the next open must read it again.
        const convo = stateRef.current.conversationId;
        if (convo) {
          void queryClient.invalidateQueries({
            queryKey: aiConversationKeys.detail(convo),
            refetchType: "none",
          });
        }
        const code = event.error?.code;
        if (code === "AI_DISABLED" || code === "FORBIDDEN") {
          void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
        }
        return;
      }
      if (event.type !== "tool.result") return;
      const plan = planEffects(event, {
        live: allowNavigate,
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
   * `status` seeds the run status the loop knows before any event arrives; `allowNavigate: false` (a
   * manual Reconnect) never auto-navigates from replayed navigate results.
   */
  const follow = useCallback(
    async (
      runId: string,
      fromEventId: string | null,
      options: { status?: string | null; allowNavigate?: boolean } = {},
    ) => {
      followRef.current?.abort();
      const controller = new AbortController();
      followRef.current = controller;
      const { signal } = controller;
      const allowNavigate = options.allowNavigate ?? true;
      const known = stateRef.current.run;
      let lastEventId = fromEventId;
      let failures = 0;
      let status: string | null =
        options.status ?? (known && known.id === runId ? known.status : null);

      /** One more failed connection: back off, or give up with the re-read fallback. Returns false to stop. */
      const failed = async (): Promise<boolean> => {
        failures += 1;
        if (failures > MAX_RECONNECTS) {
          setConnection("lost");
          dispatch({ type: "notice", error: { code: "NETWORK", message: "" } });
          const convo = stateRef.current.conversationId;
          if (convo) await rehydrate(convo);
          return false;
        }
        setConnection("reconnecting");
        await sleep(backoffMs(failures), signal);
        return true;
      };

      while (!signal.aborted) {
        let received = 0;
        try {
          const stream = await streamAiRunEvents(runId, { lastEventId, signal });
          setConnection("open");
          for await (const message of stream) {
            if (signal.aborted) break;
            const event = parseRunEvent(message);
            if (!event) continue;
            received += 1;
            const id = eventSeq(message.lastEventId, runId) !== null ? message.lastEventId : null;
            if (id) lastEventId = id;
            dispatch({ type: "event", runId, eventId: id, event });
            applyEffects(event, allowNavigate);
            if (
              event.type === "run.status" ||
              event.type === "run.snapshot" ||
              event.type === "run.finished"
            ) {
              status = event.status;
            }
          }
          if (signal.aborted) break;
          const next = afterStreamEnded(status, received);
          if (next === "stop") break;
          if (next === "resume") {
            // The server closed early (its maximum stream lifetime): resume where we are.
            failures = 0;
            continue;
          }
          // A connection that delivered nothing and closed: back off like a failure, never spin.
          if (!(await failed())) break;
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof ApiError && error.status === 401) {
            // The session is gone: the app-wide sign-out handling, never a chat notice.
            handleAuthExpiry(error);
            break;
          }
          if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            handlePasswordChangeRequired(error);
            dispatch({ type: "notice", error: noticeFrom(error) });
            break;
          }
          if (!(await failed())) break;
        }
      }
      if (followRef.current === controller) {
        followRef.current = null;
        setConnection((current) => (current === "lost" ? current : "idle"));
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
    // Only a read made after this mount: a cached copy from an earlier open can be behind.
    if (!data || !detail.isFetchedAfterMount || hydratedFor.current === data.id) return;
    hydratedFor.current = data.id;
    dispatch({ type: "hydrate", detail: data });
    const runId = data.activeRunId;
    // Subscribing starts network work that reports back through state: begin it after this commit.
    const seed = runStatusOfConversation(data.status);
    if (runId) queueMicrotask(() => void follow(runId, null, { status: seed }));
  }, [detail.data, detail.isFetchedAfterMount, follow]);

  // Stop following when the panel unmounts; the run itself continues on the server.
  // Its cached transcript is stale from then on, so the next open reads it again.
  useEffect(
    () => () => {
      followRef.current?.abort();
      const convo = stateRef.current.conversationId;
      if (convo) {
        void queryClient.invalidateQueries({
          queryKey: aiConversationKeys.detail(convo),
          refetchType: "none",
        });
      }
    },
    [queryClient],
  );

  const resetTo = useCallback(
    (id: string | null) => {
      followRef.current?.abort();
      followRef.current = null;
      appliedRef.current = new Set();
      hydratedFor.current = null;
      setConnection("idle");
      if (id) queryClient.removeQueries({ queryKey: aiConversationKeys.detail(id) });
      dispatch({ type: "reset", conversationId: id });
      setDraft(DEFAULT_CHAT_SETTINGS);
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
          const created = await createConversation.mutateAsync(createBody(draftRef.current));
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

  /**
   * Approves or rejects a pending write; on success re-subscribes to the run. Called directly (not through
   * `useMutation`) so the step-up password never lands in the mutation cache; the global auth reactions
   * the mutation cache would run are applied by hand. The STEP_UP_* 403s are neither: they stay inline.
   */
  const decideCall = useCallback(
    async (
      toolCallId: string,
      decision: AiApprovalDecisionValue,
      password?: string,
    ): Promise<DecisionResult> => {
      const run = stateRef.current.run;
      if (!run) return { ok: false, error: { kind: "notAwaiting" } };
      try {
        const accepted = await decideAiToolCall(run.id, toolCallId, {
          decision,
          ...(password ? { password } : {}),
        });
        dispatch({ type: "runStarted", runId: run.id, status: accepted.status });
        void follow(run.id, stateRef.current.run?.lastEventId ?? run.lastEventId, {
          status: accepted.status,
        });
        return { ok: true };
      } catch (error) {
        handleAuthExpiry(error);
        handlePasswordChangeRequired(error);
        const kind = decisionErrorKind(error);
        if (kind.kind === "aiDisabled") {
          void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
        }
        // The card changed or was decided elsewhere: a fresh snapshot re-renders it from the server.
        if (decisionNeedsRefresh(kind)) void follow(run.id, null);
        return { ok: false, error: kind };
      }
    },
    [follow, queryClient],
  );

  /**
   * Answers a pending input form (#1388) — `submit` with the checked body, `skip` or `cancel` — and on
   * success re-subscribes to the run (the server closed the stream when the run paused). Called directly,
   * like the decision: the answer may hold personal data and has no place in the mutation cache.
   * `answer` is the normalized answer the card keeps showing once the form is resolved.
   */
  const answerInput = useCallback(
    async (
      toolCallId: string,
      body: AiInputSubmission,
      answer?: AiInputAnswer,
    ): Promise<InputResult> => {
      const run = stateRef.current.run;
      if (!run) return { ok: false, error: { kind: "notAwaiting" } };
      try {
        const accepted = await answerAiInput(run.id, toolCallId, body);
        if (body.action === "submit" && answer) {
          dispatch({ type: "inputAnswered", toolCallId, answer });
        }
        dispatch({ type: "runStarted", runId: run.id, status: accepted.status });
        void follow(run.id, stateRef.current.run?.lastEventId ?? run.lastEventId, {
          status: accepted.status,
        });
        return { ok: true };
      } catch (error) {
        handleAuthExpiry(error);
        handlePasswordChangeRequired(error);
        const kind = inputErrorKind(error);
        if (kind.kind === "aiDisabled") {
          void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
        }
        // Answered elsewhere, or expired: a fresh snapshot re-renders the card from the server.
        if (inputNeedsRefresh(kind)) void follow(run.id, null);
        return { ok: false, error: kind };
      }
    },
    [follow, queryClient],
  );

  /**
   * A form's time ran out in this browser. The stream is closed while the run waits, so nothing else
   * would report that the server expired it: re-read the run (a fresh snapshot) once the API's sweeper has
   * had time to end it, and again a couple of times if it still waits. Idempotent per wait.
   */
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputExpired = useCallback(() => {
    if (expiryTimer.current !== null) return;
    let attempts = 0;
    const recheck = () => {
      const run = stateRef.current.run;
      if (!run || run.status !== "AWAITING_INPUT") {
        expiryTimer.current = null;
        return;
      }
      if (!followRef.current) void follow(run.id, null);
      attempts += 1;
      expiryTimer.current = attempts < 3 ? setTimeout(recheck, EXPIRY_RECHECK_MS) : null;
    };
    expiryTimer.current = setTimeout(recheck, EXPIRY_RECHECK_MS);
  }, [follow]);
  useEffect(
    () => () => {
      if (expiryTimer.current !== null) clearTimeout(expiryTimer.current);
    },
    [],
  );

  /** Reconnects after "connection lost". */
  const reconnect = useCallback(() => {
    const run = stateRef.current.run;
    // Replayed navigate results never move the user after a manual reconnect.
    if (run) void follow(run.id, run.lastEventId, { allowNavigate: false });
  }, [follow]);

  const dismissNotice = useCallback(() => dispatch({ type: "notice", error: null }), []);

  return {
    conversationId,
    state,
    connection,
    // Opening a conversation waits for a read made after mount, never a cached copy.
    loading:
      conversationId !== null &&
      state.messages.length === 0 &&
      !detail.isFetchedAfterMount &&
      !detail.isError,
    loadError: detail.error,
    readOnly: detail.data?.readOnly === true || state.runError?.code === "CONVERSATION_READ_ONLY",
    /** The server's settings of the open chat (absent from an older API, and before it is read). */
    settings: conversationId !== null ? (detail.data?.settings ?? null) : null,
    /** A new chat's local settings (sent with the create). */
    draft,
    setDraft,
    sending: createConversation.isPending || send.isPending,
    stopping: cancel.isPending,
    openConversation,
    newChat,
    sendMessage,
    stop,
    decide: decideCall,
    answerInput,
    inputExpired,
    reconnect,
    dismissNotice,
  };
}

export type AiTurn = ReturnType<typeof useAiTurn>;
