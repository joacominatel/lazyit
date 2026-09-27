import type {
  AiConversationDetail,
  CreateAiConversation,
  UpdateAiConversation,
} from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { settingsErrorKey } from "@/lib/ai/chat-settings";
import {
  createAiConversation,
  deleteAiConversation,
  getAiConversation,
  listAiConversations,
  updateAiConversation,
} from "../endpoints/ai";
import { aiKeys } from "./use-ai-status";

/**
 * The chat's conversations (frontend.md K3). Keys live under the single `["ai"]` root, so the
 * "invalidate everything but the assistant" predicate never refetches the chat's own state.
 */
export const aiConversationKeys = {
  all: () => [...aiKeys.all, "conversations"] as const,
  list: () => [...aiConversationKeys.all(), "list"] as const,
  detail: (id: string) => [...aiConversationKeys.all(), "detail", id] as const,
};

/** How many conversations the history shows (most recent first). */
export const AI_HISTORY_PAGE_SIZE = 50;

/** The caller's own conversations, newest first. */
export function useAiConversations(enabled = true) {
  return useQuery({
    queryKey: aiConversationKeys.list(),
    queryFn: () => listAiConversations({ limit: AI_HISTORY_PAGE_SIZE }),
    enabled,
    staleTime: 30 * 1000,
  });
}

/**
 * One conversation with its messages. Read FRESH on every mount (`refetchOnMount: "always"`): the panel
 * remounts when it is reopened, and a cached copy from an earlier open would miss the turns, the pending
 * approval or the active run added since. The chat hydrates only from a read made after it mounted
 * (`isFetchedAfterMount`). It is not refetched on focus: while the panel is open the live run stream owns
 * the state, and `useAiTurn` marks the copy stale when a run finishes and when the panel closes.
 */
export function useAiConversation(id: string | null) {
  return useQuery({
    queryKey: aiConversationKeys.detail(id ?? ""),
    queryFn: () => getAiConversation(id!),
    enabled: id !== null,
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
}

export function useCreateAiConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: CreateAiConversation) => createAiConversation(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: aiConversationKeys.list() }),
  });
}

/**
 * Changes a conversation's settings (#1373, #1376): the answer replaces the `settings` of the cached
 * detail, so the popover and the "Auto" badge follow at once without re-reading the transcript. A
 * `CONVERSATION_SETTINGS_LOCKED` refusal marks the cached settings locked (a run started elsewhere).
 */
export function useUpdateAiConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: UpdateAiConversation }) =>
      updateAiConversation(vars.id, vars.patch),
    onSuccess: (settings, { id }) => {
      queryClient.setQueryData<AiConversationDetail>(aiConversationKeys.detail(id), (old) =>
        old ? { ...old, settings } : old,
      );
    },
    onError: (error, { id }) => {
      if (settingsErrorKey(error) !== "locked") return;
      queryClient.setQueryData<AiConversationDetail>(aiConversationKeys.detail(id), (old) =>
        old?.settings ? { ...old, settings: { ...old.settings, modelLocked: true } } : old,
      );
    },
  });
}

/** Deletes one of the caller's conversations (409 `RUN_IN_PROGRESS` while it runs). */
export function useDeleteAiConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAiConversation(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: aiConversationKeys.detail(id) });
      return queryClient.invalidateQueries({ queryKey: aiConversationKeys.list() });
    },
  });
}
