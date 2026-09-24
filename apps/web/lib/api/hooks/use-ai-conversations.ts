import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAiConversation,
  deleteAiConversation,
  getAiConversation,
  listAiConversations,
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
 * One conversation with its messages. Not refetched on focus: the live run stream owns the in-flight
 * state, and a refetch here would re-hydrate over it.
 */
export function useAiConversation(id: string | null) {
  return useQuery({
    queryKey: aiConversationKeys.detail(id ?? ""),
    queryFn: () => getAiConversation(id!),
    enabled: id !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useCreateAiConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => createAiConversation(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: aiConversationKeys.list() }),
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
